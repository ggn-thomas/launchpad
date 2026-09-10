import {
  CpAmm,
  getUnClaimLpFee,
  type PoolState,
} from '@meteora-ag/cp-amm-sdk'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { BASE_DECIMALS, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { loadLaunch } from './lib/store.js'
import { sendTransaction } from './lib/tx.js'

/**
 * Claims trading fees from the graduated DAMM v2 pool.
 *
 * These are a different program and a different account model from the bonding
 * curve: the migrated liquidity is held as position NFTs, and fees accrue on
 * the positions rather than on the DBC pool. `npm run claim` cannot see them.
 *
 * Permanently locked liquidity still earns — claiming fees is a separate
 * instruction from withdrawing liquidity, so a 100% locked position collects
 * normally.
 */
function amount(raw: BN, decimals: number, unit: string): string {
  const value = Number(raw.toString()) / 10 ** decimals
  if (value > 0 && value < 0.000001) return `${raw.toString()} base units of ${unit}`
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`
}

/** Which side of the pair is the launched token, so amounts get the right label. */
function sideLabels(poolState: PoolState, baseMint: PublicKey) {
  const baseIsA = poolState.tokenAMint.equals(baseMint)
  return {
    a: baseIsA ? { label: 'BASE', decimals: BASE_DECIMALS } : { label: QUOTE_LABEL, decimals: QUOTE_DECIMALS },
    b: baseIsA ? { label: QUOTE_LABEL, decimals: QUOTE_DECIMALS } : { label: 'BASE', decimals: BASE_DECIMALS },
  }
}

async function main(): Promise<void> {
  const connection = createConnection()
  const launch = loadLaunch(config.token.symbol)
  const cpAmm = new CpAmm(connection)

  const owner = loadKeypair(config.wallets.creator)
  await assertFunded(connection, owner, 0.01, 'Owner')

  // The migrated pool address is derived from the DAMM v2 config that
  // MIGRATION_FEE_OPTION selected, plus the two mints.
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migration.feeOption]
  if (!dammConfig) throw new Error(`No DAMM v2 config for fee option ${config.migration.feeOption}`)

  const baseMint = new PublicKey(launch.baseMint)
  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, config.quote.mint)

  if (!(await connection.getAccountInfo(dammPool))) {
    throw new Error(
      `No DAMM v2 pool at ${dammPool.toBase58()}. The launch has not migrated yet — run \`npm run migrate\`.`,
    )
  }

  const poolState = await cpAmm.fetchPoolState(dammPool)
  const positions = await cpAmm.getUserPositionByPool(dammPool, owner.publicKey)

  const labels = sideLabels(poolState, baseMint)
  const symbolFor = (label: string) => (label === 'BASE' ? launch.symbol : label)

  console.log(`${launch.name} (${launch.symbol}) — DAMM v2`)
  console.log(`  pool      ${dammPool.toBase58()}`)
  console.log(`  positions ${positions.length}`)
  // Which token fees arrive in is fixed by the pool's collect fee mode; the
  // migration presets collect in the quote token only.
  console.log(`  fees in   ${['token A and B', QUOTE_LABEL + ' only', QUOTE_LABEL + ' (compounding)'][poolState.collectFeeMode] ?? poolState.collectFeeMode}\n`)

  if (positions.length === 0) {
    console.log(`No position owned by ${owner.publicKey.toBase58()} in this pool.`)
    return
  }

  let claimedAny = false

  for (const { position, positionNftAccount, positionState } of positions) {
    const pending = getUnClaimLpFee(poolState, positionState)
    const hasFees = pending.feeTokenA.gt(new BN(0)) || pending.feeTokenB.gt(new BN(0))

    console.log(`Position ${position.toBase58()}`)
    console.log(`  pending  ${amount(pending.feeTokenA, labels.a.decimals, symbolFor(labels.a.label))}`)
    console.log(`  pending  ${amount(pending.feeTokenB, labels.b.decimals, symbolFor(labels.b.label))}`)

    if (!hasFees) {
      console.log('  nothing to claim\n')
      continue
    }

    const tx = await cpAmm.claimPositionFee({
      owner: owner.publicKey,
      position,
      pool: dammPool,
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: poolState.tokenAFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
      tokenBProgram: poolState.tokenBFlag === 0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    })
    await sendTransaction(connection, tx, [owner], 'claim position fee')
    console.log()
    claimedAny = true
  }

  if (!claimedAny) {
    console.log('Nothing pending. Fees accrue as the DAMM v2 pool trades.')
  }
}

main().catch((error: unknown) => {
  console.error(`\nPool claim failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
