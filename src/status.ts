import { CpAmm, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { PublicKey } from '@solana/web3.js'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { config, createConnection, loadKeypair } from './env.js'
import { BASE_DECIMALS, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { loadLaunch } from './lib/store.js'
import { explorerAddress } from './lib/tx.js'

function toQuote(amount: BN): string {
  return (Number(amount.toString()) / 10 ** QUOTE_DECIMALS).toFixed(6)
}

function bar(progress: number, width = 30): string {
  const filled = Math.max(0, Math.min(width, Math.round(progress * width)))
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${(progress * 100).toFixed(2)}%`
}

async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const launch = loadLaunch(config.token.symbol)

  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)

  // A VirtualPool wraps the on-chain account fields under `poolState`.
  const { poolState: poolAccount } = poolState
  const [quoteProgress, threshold, feeMetrics, feeBreakdown] = await Promise.all([
    client.state.getPoolQuoteTokenCurveProgress(pool),
    client.state.getPoolMigrationQuoteThreshold(pool),
    client.state.getPoolFeeMetrics(pool),
    client.state.getPoolFeeBreakdown(pool),
  ])

  const price = getPriceFromSqrtPrice(poolAccount.sqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS)

  console.log(`${launch.name} (${launch.symbol})`)
  console.log(`  mint   ${launch.baseMint}`)
  console.log(`  pool   ${launch.pool}`)
  console.log(`  ${explorerAddress(launch.baseMint)}\n`)

  console.log('Curve')
  console.log(`  progress   ${bar(quoteProgress)}`)
  console.log(`  raised     ${toQuote(poolAccount.quoteReserve)} / ${toQuote(threshold)} ${QUOTE_LABEL}`)
  console.log(`  price      ${price.toSignificantDigits(6).toString()} ${QUOTE_LABEL} per ${launch.symbol}`)
  console.log(`  completed  ${poolAccount.isMigrated === 1 ? 'migrated to DAMM v2' : quoteProgress >= 1 ? 'yes, awaiting migration' : 'no'}\n`)

  // Curve fees stop accruing at migration. Anything earned after that lives on
  // the DAMM v2 position NFTs, in a different program, so it is reported apart.
  console.log('Curve fees  (bonding phase, stops at migration)')
  console.log(`  total traded       ${toQuote(feeMetrics.total.totalTradingQuoteFee)} ${QUOTE_LABEL}`)
  console.log(`  creator unclaimed  ${toQuote(feeBreakdown.creator.unclaimedQuoteFee)} ${QUOTE_LABEL}`)
  console.log(`  partner unclaimed  ${toQuote(feeBreakdown.partner.unclaimedQuoteFee)} ${QUOTE_LABEL}`)

  if (poolAccount.isMigrated !== 1) return

  await reportPoolFees(launch.baseMint)
}

/**
 * Fees earned by the graduated DAMM v2 pool, which `npm run claim` cannot see.
 * Reported per position, since migration can mint one for the partner and one
 * for the creator.
 */
async function reportPoolFees(baseMint: string): Promise<void> {
  const connection = createConnection()
  const cpAmm = new CpAmm(connection)

  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migration.feeOption]
  if (!dammConfig) return
  const dammPool = deriveDammV2PoolAddress(dammConfig, new PublicKey(baseMint), config.quote.mint)
  if (!(await connection.getAccountInfo(dammPool))) return

  const poolState = await cpAmm.fetchPoolState(dammPool)
  const owner = loadKeypair(config.wallets.creator)
  const positions = await cpAmm.getUserPositionByPool(dammPool, owner.publicKey)

  let pending = new BN(0)
  let claimed = new BN(0)
  for (const { positionState } of positions) {
    pending = pending.add(getUnClaimLpFee(poolState, positionState).feeTokenB)
    claimed = claimed.add(positionState.metrics.totalClaimedBFee)
  }

  console.log(`\nPool fees  (DAMM v2, perpetual — run \`claim-pool\`)`)
  console.log(`  paid to all LPs    ${toQuote(poolState.metrics.totalLpBFee)} ${QUOTE_LABEL}`)
  console.log(`  your pending       ${toQuote(pending)} ${QUOTE_LABEL}`)
  console.log(`  your claimed       ${toQuote(claimed)} ${QUOTE_LABEL}`)
  console.log(`  positions          ${positions.length}`)
}

main().catch((error: unknown) => {
  console.error(`\nStatus failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
