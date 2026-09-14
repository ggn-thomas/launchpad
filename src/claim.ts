import { DynamicBondingCurveClient, U64_MAX } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { BASE_DECIMALS, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { amount } from './lib/format.js'
import { routeLeftover } from './lib/leftover.js'
import { loadLaunch } from './lib/store.js'
import { sendTransaction } from './lib/tx.js'

const POST_BONDING_CURVE = 1
const CREATED_POOL = 3

/**
 * withdraw_migration_fee takes a flag of 0 for the partner and 1 for the
 * creator, and records each withdrawal as that bit in migrationFeeWithdrawStatus.
 */
const PARTNER_MIGRATION_FEE_BIT = 1 << 0
const CREATOR_MIGRATION_FEE_BIT = 1 << 1

/**
 * Below this, a claim costs more in transaction fees than it recovers. Base
 * units of the quote token, sized against a typical signature fee.
 */
const DUST_THRESHOLD = new BN(20_000)

/**
 * The migration fee is what the threshold loses to the rounded-up migration
 * quote amount, then split by the creator's percentage.
 */
function migrationFeeShares(threshold: BN, feePct: number, creatorPct: number) {
  const migrationQuoteAmount = threshold.muln(100 - feePct).addn(99).divn(100)
  const fee = threshold.sub(migrationQuoteAmount)
  const creator = fee.muln(creatorPct).divn(100)
  return { creator, partner: fee.sub(creator) }
}

/**
 * Collects everything a launch has earned.
 *
 * Which side holds the money is decided by CREATOR_FEE_PCT and
 * MIGRATION_CREATOR_FEE_PCT, so this reads the on-chain state rather than
 * assuming: calling the wrong side's path returns nothing and looks like a
 * failure.
 */
async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const launch = loadLaunch(config.token.symbol)

  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)
  const account = poolState.poolState

  const configState = await client.state.getPoolConfig(account.config)
  if (!configState) throw new Error('Pool config not found')

  const breakdown = await client.state.getPoolFeeBreakdown(pool)
  const completed = account.migrationProgress >= POST_BONDING_CURVE
  const migrated = account.migrationProgress === CREATED_POOL

  // Quote raised beyond the migration threshold is surplus, claimable once the
  // curve has completed and split by the same CREATOR_FEE_PCT as trading fees.
  const surplus = account.quoteReserve.sub(configState.migrationQuoteThreshold)
  const hasSurplus = surplus.gte(DUST_THRESHOLD)

  const migrationFee = migrationFeeShares(
    configState.migrationQuoteThreshold,
    configState.migrationFeePercentage,
    configState.creatorMigrationFeePercentage,
  )
  const withdrawStatus = account.migrationFeeWithdrawStatus

  console.log(`${launch.name} (${launch.symbol})`)
  console.log(`  pool     ${launch.pool}`)
  console.log(`  migrated ${migrated ? 'yes' : completed ? 'curve complete, not migrated yet' : 'no'}\n`)

  console.log('Unclaimed')
  for (const [side, fees] of [
    ['creator', breakdown.creator],
    ['partner', breakdown.partner],
  ] as const) {
    console.log(
      `  ${side}  ${amount(fees.unclaimedQuoteFee, QUOTE_DECIMALS, QUOTE_LABEL).padStart(16)}` +
        `  +  ${amount(fees.unclaimedBaseFee, BASE_DECIMALS, launch.symbol)}`,
    )
  }
  if (surplus.gt(new BN(0))) {
    console.log(
      `  surplus ${amount(surplus, QUOTE_DECIMALS, QUOTE_LABEL)}` +
        `${hasSurplus ? '' : ' — dust, costs more in fees than it returns, skipping'}`,
    )
  }
  for (const [side, share, bit] of [
    ['creator', migrationFee.creator, CREATOR_MIGRATION_FEE_BIT],
    ['partner', migrationFee.partner, PARTNER_MIGRATION_FEE_BIT],
  ] as const) {
    if (share.isZero()) continue
    const state = (withdrawStatus & bit) !== 0 ? 'already withdrawn' : completed ? '' : 'available once the curve completes'
    console.log(`  migration fee (${side})  ${amount(share, QUOTE_DECIMALS, QUOTE_LABEL)}${state ? ` — ${state}` : ''}`)
  }
  console.log()

  const creator = loadKeypair(config.wallets.creator)
  const partner = loadKeypair(config.wallets.partner)
  await assertFunded(connection, creator, 0.01, 'Creator')

  const creatorHasFees =
    breakdown.creator.unclaimedQuoteFee.gt(new BN(0)) || breakdown.creator.unclaimedBaseFee.gt(new BN(0))
  const partnerHasFees =
    breakdown.partner.unclaimedQuoteFee.gt(new BN(0)) || breakdown.partner.unclaimedBaseFee.gt(new BN(0))

  let claimed = 0

  if (creatorHasFees) {
    // U64_MAX means "take everything available" rather than a computed figure
    // that a swap landing mid-transaction could invalidate.
    const tx = await client.creator.claimCreatorTradingFeeToReceiver({
      creator: creator.publicKey,
      payer: creator.publicKey,
      pool,
      maxBaseAmount: U64_MAX,
      maxQuoteAmount: U64_MAX,
      receiver: creator.publicKey,
    })
    await sendTransaction(connection, tx, [creator], 'claim creator trading fees')
    claimed += 1
  }

  if (partnerHasFees) {
    const tx = await client.partner.claimPartnerTradingFeeToReceiver({
      feeClaimer: partner.publicKey,
      payer: partner.publicKey,
      pool,
      maxBaseAmount: U64_MAX,
      maxQuoteAmount: U64_MAX,
      receiver: partner.publicKey,
    })
    await sendTransaction(connection, tx, [partner], 'claim partner trading fees')
    claimed += 1
  }

  // Surplus withdrawal is gated by a one-time flag per side, so a second run
  // must not retry it.
  if (hasSurplus && config.fee.creatorPct > 0 && account.isCreatorWithdrawSurplus === 0) {
    const tx = await client.creator.creatorWithdrawSurplus({ creator: creator.publicKey, pool })
    await sendTransaction(connection, tx, [creator], 'withdraw creator surplus')
    claimed += 1
  }
  if (hasSurplus && config.fee.creatorPct < 100 && account.isPartnerWithdrawSurplus === 0) {
    const tx = await client.partner.partnerWithdrawSurplus({ feeClaimer: partner.publicKey, pool })
    await sendTransaction(connection, tx, [partner], 'withdraw partner surplus')
    claimed += 1
  }

  // The migration fee is paid to whoever signs as that side, in native SOL: the
  // SDK unwraps the quote token for a SOL pair. The creator side therefore
  // lands on the creator wallet, which is the dev wallet unless
  // CREATOR_KEYPAIR says otherwise.
  if (completed && !migrationFee.creator.isZero() && (withdrawStatus & CREATOR_MIGRATION_FEE_BIT) === 0) {
    const tx = await client.creator.creatorWithdrawMigrationFee({ pool, sender: creator.publicKey })
    await sendTransaction(connection, tx, [creator], 'withdraw creator migration fee')
    claimed += 1
  }
  if (completed && !migrationFee.partner.isZero() && (withdrawStatus & PARTNER_MIGRATION_FEE_BIT) === 0) {
    const tx = await client.partner.partnerWithdrawMigrationFee({ pool, sender: partner.publicKey })
    await sendTransaction(connection, tx, [partner], 'withdraw partner migration fee')
    claimed += 1
  }

  // Leftover only becomes withdrawable once the migrated pool exists.
  if (migrated && (await routeLeftover(connection, client, launch, [partner, creator]))) {
    claimed += 1
  }

  if (claimed === 0) {
    console.log('Nothing to claim.')
    return
  }

  const after = await client.state.getPoolFeeBreakdown(pool)
  console.log('\nClaimed. Remaining unclaimed:')
  console.log(`  creator ${amount(after.creator.unclaimedQuoteFee, QUOTE_DECIMALS, QUOTE_LABEL)}`)
  console.log(`  partner ${amount(after.partner.unclaimedQuoteFee, QUOTE_DECIMALS, QUOTE_LABEL)}`)
}

main().catch((error: unknown) => {
  console.error(`\nClaim failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
