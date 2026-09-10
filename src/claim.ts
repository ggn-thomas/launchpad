import { DynamicBondingCurveClient, U64_MAX } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { BASE_DECIMALS, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { loadLaunch } from './lib/store.js'
import { sendTransaction } from './lib/tx.js'

const CREATED_POOL = 3

/**
 * Below this, a claim costs more in transaction fees than it recovers. Base
 * units of the quote token, sized against a typical signature fee.
 */
const DUST_THRESHOLD = new BN(20_000)

/**
 * Formats a raw amount with its unit. A non-zero balance never renders as "0" —
 * that reads as nothing to claim while the script goes ahead and claims it.
 */
function amount(raw: BN, decimals: number, unit: string): string {
  const value = Number(raw.toString()) / 10 ** decimals
  if (value > 0 && value < 0.000001) return `${raw.toString()} base units of ${unit}`
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`
}

/**
 * Collects everything a launch has earned.
 *
 * Which side holds the money is decided by CREATOR_FEE_PCT, so this reads the
 * on-chain breakdown rather than assuming: calling the creator path on a
 * partner-weighted launch returns nothing and looks like a failure.
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
  const migrated = account.migrationProgress === CREATED_POOL

  // Quote raised beyond the migration threshold is surplus, claimable once the
  // curve has completed and split by the same CREATOR_FEE_PCT as trading fees.
  const surplus = account.quoteReserve.sub(configState.migrationQuoteThreshold)
  const hasSurplus = surplus.gte(DUST_THRESHOLD)

  console.log(`${launch.name} (${launch.symbol})`)
  console.log(`  pool     ${launch.pool}`)
  console.log(`  migrated ${migrated ? 'yes' : 'no'}\n`)

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

  // Leftover only becomes withdrawable once the migrated pool exists, and only
  // ever pays the config's leftover receiver.
  if (migrated && account.isWithdrawLeftover === 0 && config.token.leftover > 0) {
    if (config.token.leftover < 1000) {
      console.log(`  leftover ${config.token.leftover} base units of ${launch.symbol} — dust, skipping`)
    } else {
      const tx = await client.migration.withdrawLeftover({ payer: partner.publicKey, pool })
      await sendTransaction(connection, tx, [partner], 'withdraw leftover')
      claimed += 1
    }
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
