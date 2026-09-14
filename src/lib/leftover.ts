import type { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { PublicKey, Transaction, type Connection, type Keypair, type TokenBalance } from '@solana/web3.js'
import BN from 'bn.js'
import { config } from '../env.js'
import { amount } from './format.js'
import { checkRecipient } from './recipient.js'
import { saveLaunch, type LaunchRecord } from './store.js'
import { explorerTx, sendTransaction } from './tx.js'

const CREATED_POOL = 3

/** Anchor logs the instruction name on entry, which is how a past withdrawal is found. */
const WITHDRAW_LEFTOVER_LOG = 'Program log: Instruction: WithdrawLeftover'

/** Pages of 100 pool transactions searched. The withdrawal follows migration, so it is recent. */
const HISTORY_PAGES = 5

/** Allows sending the split for a leftover that was withdrawn without it. */
export const FORWARD_FLAG = '--forward-leftover'

type Split = { communityWallet: PublicKey; treasuryWallet: PublicKey; communityAmount: number }
type Share = { key: string; label: string; wallet: PublicKey; raw: BN }
/** Decimals come from the chain, not .env: transferChecked rejects any mismatch. */
type Token = { mint: PublicKey; decimals: number; program: PublicKey; symbol: string }

/**
 * Withdraws the leftover and, when LEFTOVER_*_WALLET are set, splits it.
 *
 * The program only ever pays the config's leftover receiver, the partner
 * wallet. The split therefore rides in the same transaction as the withdrawal:
 * the receiver's token account is credited and debited atomically, the tokens
 * never rest on the partner wallet, and a failure leaves nothing half-routed.
 *
 * withdraw_leftover is permissionless, though: anyone can call it first and
 * land the whole leftover on the partner wallet unsplit. That case is read from
 * the pool history and forwarded only on an explicit --forward-leftover, then
 * recorded in the launch record so it cannot be sent twice.
 *
 * Returns whether a transaction was sent.
 */
export async function routeLeftover(
  connection: Connection,
  client: DynamicBondingCurveClient,
  launch: LaunchRecord,
  keypairs: Keypair[],
): Promise<boolean> {
  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)
  const account = poolState.poolState
  if (account.migrationProgress !== CREATED_POOL) return false

  const configState = await client.state.getPoolConfig(account.config)
  if (!configState) throw new Error('Pool config not found')
  const receiver = configState.leftoverReceiver

  const { communityWallet, treasuryWallet, communityAmount } = config.leftoverSplit
  const split: Split | null = communityWallet && treasuryWallet ? { communityWallet, treasuryWallet, communityAmount } : null

  // Forwarding the tokens needs the receiver's signature, so the receiver has to
  // be one of the keypairs this script holds.
  const signer = keypairs.find((keypair) => keypair.publicKey.equals(receiver))
  if (split && !signer) {
    throw new Error(
      `The leftover receiver ${receiver.toBase58()} is not a wallet this script can sign for, ` +
        'so it cannot forward the split. The receiver is fixed in the config at launch.',
    )
  }
  const payer = signer ?? keypairs[0]!

  const mint = account.baseMint
  const mintInfo = await connection.getAccountInfo(mint)
  const token: Token = {
    mint,
    decimals: configState.tokenDecimal,
    program: mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    symbol: launch.symbol,
  }
  const receiverAta = getAssociatedTokenAddressSync(mint, receiver, true, token.program)
  const format = (raw: BN) => amount(raw, token.decimals, token.symbol)

  if (account.isWithdrawLeftover === 0) {
    const tx = await client.migration.withdrawLeftover({ payer: payer.publicKey, pool })
    const leftover = await simulateLeftover(connection, tx, payer, receiverAta)
    if (leftover.isZero()) {
      console.log('  leftover  nothing to withdraw')
      return false
    }
    if (!split) {
      console.log(`  leftover  ${format(leftover)} → ${receiver.toBase58()}`)
      await sendTransaction(connection, tx, [payer], 'withdraw leftover')
      return true
    }

    const shares = await planSplit(connection, split, leftover, token)
    console.log(`  leftover  ${format(leftover)}, withdrawn and split in one transaction:`)
    appendSplit(tx, shares, token, receiverAta, payer.publicKey)
    const signature = await sendTransaction(connection, tx, [payer], 'withdraw and split leftover')
    saveLaunch({ ...launch, leftoverSplit: signature })
    return true
  }

  // Withdrawn already. With a split configured, find out whether it was split.
  if (!split) return false
  if (launch.leftoverSplit) {
    console.log(`  leftover  already split -> ${explorerTx(launch.leftoverSplit)}`)
    return false
  }
  const past = await findWithdrawal(connection, pool, receiver, mint)
  if (!past) {
    throw new Error(
      `The leftover was withdrawn, but not within the last ${HISTORY_PAGES * 100} pool transactions. ` +
        `Check wallet ${receiver.toBase58()} by hand. Nothing was sent.`,
    )
  }
  // The receiver's balance nets to zero across a withdraw-and-split.
  if (past.kept.lten(0)) {
    console.log(`  leftover  already split -> ${explorerTx(past.signature)}`)
    return false
  }

  console.log(`  leftover  ${format(past.kept)} was withdrawn unsplit to ${receiver.toBase58()}`)
  console.log(`            ${explorerTx(past.signature)}`)
  if (!process.argv.includes(FORWARD_FLAG)) {
    console.log(`            run \`launchpad claim ${FORWARD_FLAG}\` to send the split from that wallet`)
    return false
  }

  const balance = await tokenBalance(connection, receiverAta)
  if (balance.lt(past.kept)) {
    throw new Error(
      `Wallet ${receiver.toBase58()} holds ${format(balance)}, less than the ${format(past.kept)} withdrawn: ` +
        'some of it has already moved. Nothing was sent.',
    )
  }
  const shares = await planSplit(connection, split, past.kept, token)
  // The launch record is the guard against a second forward, and it is local.
  // Destinations already holding their shares mean it was sent from elsewhere.
  const held = await Promise.all(
    shares.map((share) => tokenBalance(connection, getAssociatedTokenAddressSync(mint, share.wallet, true, token.program))),
  )
  if (shares.every((share, i) => held[i]!.gte(share.raw))) {
    throw new Error('Both split wallets already hold at least their share, so it looks forwarded already. Nothing was sent.')
  }

  console.log('  forwarding the split:')
  const tx = new Transaction()
  appendSplit(tx, shares, token, receiverAta, payer.publicKey)
  const signature = await sendTransaction(connection, tx, [payer], 'forward leftover split')
  saveLaunch({ ...launch, leftoverSplit: signature })
  return true
}

/**
 * The community wallet gets exactly LEFTOVER_COMMUNITY_AMOUNT, the treasury the
 * rest, rounding included. Refuses before anything is signed, because a
 * transfer to a non-wallet is permanent.
 */
async function planSplit(connection: Connection, split: Split, total: BN, token: Token): Promise<Share[]> {
  const communityRaw = new BN(split.communityAmount).mul(new BN(10).pow(new BN(token.decimals)))
  if (total.lte(communityRaw)) {
    throw new Error(
      `The leftover is ${amount(total, token.decimals, token.symbol)}, not above LEFTOVER_COMMUNITY_AMOUNT (${split.communityAmount}). Nothing was sent.`,
    )
  }
  const shares: Share[] = [
    { key: 'LEFTOVER_COMMUNITY_WALLET', label: 'community', wallet: split.communityWallet, raw: communityRaw },
    { key: 'LEFTOVER_TREASURY_WALLET', label: 'treasury', wallet: split.treasuryWallet, raw: total.sub(communityRaw) },
  ]
  for (const { key, wallet } of shares) {
    const check = await checkRecipient(connection, wallet)
    if (!check.ok) throw new Error(`${key} ${wallet.toBase58()} is ${check.reason}. Nothing was sent.`)
  }
  return shares
}

/** Adds, per share, an idempotent token account creation and a transfer out of `source`. */
function appendSplit(tx: Transaction, shares: Share[], token: Token, source: PublicKey, owner: PublicKey): void {
  const { mint, decimals, program } = token
  for (const { label, wallet, raw } of shares) {
    console.log(`    ${label.padEnd(9)}  ${amount(raw, decimals, token.symbol).padStart(24)} → ${wallet.toBase58()}`)
    // allowOwnerOffCurve: a multisig vault is a PDA, which has no private key.
    const destination = getAssociatedTokenAddressSync(mint, wallet, true, program)
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, wallet, mint, program),
      createTransferCheckedInstruction(source, mint, destination, owner, BigInt(raw.toString()), decimals, [], program),
    )
  }
}

async function tokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<BN> {
  return connection
    .getTokenAccountBalance(tokenAccount)
    .then((balance) => new BN(balance.value.amount))
    .catch(() => new BN(0))
}

/** The u64 at offset 64 of a token account is its balance, in SPL Token and Token-2022 alike. */
function tokenAccountAmount(base64: string | undefined): BN {
  if (!base64) return new BN(0)
  const data = Buffer.from(base64, 'base64')
  return data.length >= 72 ? new BN(data.readBigUInt64LE(64).toString()) : new BN(0)
}

/**
 * How many tokens withdraw_leftover will actually pay. It is not TOKEN_LEFTOVER:
 * curve rounding adds a little, and the vault also holds the protocol's
 * migration fee, which stays. Simulating the withdrawal and diffing the
 * receiver's balance gives the program's own figure.
 */
async function simulateLeftover(connection: Connection, tx: Transaction, signer: Keypair, receiverAta: PublicKey): Promise<BN> {
  const before = await tokenBalance(connection, receiverAta)
  const simulation = await connection.simulateTransaction(tx, [signer], [receiverAta])
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join('\n') ?? '(no logs returned)'
    throw new Error(`withdraw leftover failed simulation: ${JSON.stringify(simulation.value.err)}\n${logs}`)
  }
  return tokenAccountAmount(simulation.value.accounts?.[0]?.data?.[0]).sub(before)
}

/** The pool's withdraw_leftover transaction, and how much of it the receiver kept. */
async function findWithdrawal(
  connection: Connection,
  pool: PublicKey,
  receiver: PublicKey,
  mint: PublicKey,
): Promise<{ signature: string; kept: BN } | null> {
  const held = (balances: TokenBalance[] | null | undefined) =>
    new BN(balances?.find((b) => b.mint === mint.toBase58() && b.owner === receiver.toBase58())?.uiTokenAmount.amount ?? '0')

  let before: string | undefined
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const signatures = await connection.getSignaturesForAddress(pool, { limit: 100, ...(before && { before }) }, 'confirmed')
    for (const { signature, err } of signatures) {
      if (err) continue
      const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      if (!tx?.meta?.logMessages?.includes(WITHDRAW_LEFTOVER_LOG)) continue
      return { signature, kept: held(tx.meta.postTokenBalances).sub(held(tx.meta.preTokenBalances)) }
    }
    if (signatures.length < 100) break
    before = signatures.at(-1)?.signature
  }
  return null
}
