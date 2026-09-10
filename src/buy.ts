import { PublicKey } from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { BASE_DECIMALS, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { loadLaunch } from './lib/store.js'
import { sendTransaction } from './lib/tx.js'

/** Formats a raw token amount using its decimals, for display only. */
function toUi(amount: BN, decimals: number): string {
  return (Number(amount.toString()) / 10 ** decimals).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  })
}

async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const launch = loadLaunch(config.token.symbol)

  const buyer = loadKeypair(config.wallets.creator)
  await assertFunded(connection, buyer, config.trading.buyAmount + 0.02, 'Buyer')

  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)

  // A VirtualPool wraps the on-chain account fields under `poolState`.
  const { poolState: poolAccount } = poolState
  const configState = await client.state.getPoolConfig(poolAccount.config)
  if (!configState) throw new Error(`Config ${poolAccount.config.toBase58()} not found`)

  // The fee schedule and any rate limits are evaluated against the chain's
  // current point, which is a slot or a timestamp depending on the config.
  const currentPoint = await getCurrentPoint(connection, configState.activationType)
  const amountIn = new BN(Math.round(config.trading.buyAmount * 10 ** QUOTE_DECIMALS))

  // The curve only holds enough base token to absorb quote up to the migration
  // threshold. Asking ExactIn for more than that fails with "Insufficient
  // Liquidity", which every final buy of a launch would hit. PartialFill
  // consumes what the curve can still take and leaves the rest untouched.
  const room = configState.migrationQuoteThreshold.sub(poolAccount.quoteReserve)
  const overshoots = amountIn.gt(room)
  const swapMode = overshoots ? SwapMode.PartialFill : SwapMode.ExactIn

  if (overshoots) {
    console.log(
      `Curve has room for ${toUi(room, QUOTE_DECIMALS)} ${QUOTE_LABEL} before migration, ` +
        `less than the ${config.trading.buyAmount} requested — switching to a partial fill.\n`,
    )
  }

  const quote = client.pool.swapQuote2({
    virtualPool: poolState,
    config: configState,
    swapBaseForQuote: false,
    swapMode,
    amountIn,
    slippageBps: config.trading.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  })

  // ExactIn and PartialFill both yield a minimum; the quote type also covers
  // ExactOut, where the guarantee is a maximum input instead.
  const { minimumAmountOut } = quote
  if (!minimumAmountOut) throw new Error('Quote returned no minimumAmountOut')

  console.log(
    `Buying ${config.trading.buyAmount} ${QUOTE_LABEL} of ${launch.symbol}` +
      `${overshoots ? ' (partial fill)' : ''}`,
  )
  console.log(`  expected  ${toUi(quote.outputAmount, BASE_DECIMALS)} ${launch.symbol}`)
  console.log(`  minimum   ${toUi(minimumAmountOut, BASE_DECIMALS)} ${launch.symbol} at ${config.trading.slippageBps} bps slippage`)
  console.log(`  trade fee ${toUi(quote.tradingFee, QUOTE_DECIMALS)} ${QUOTE_LABEL}`)

  const swapTx = await client.pool.swap2({
    owner: buyer.publicKey,
    payer: buyer.publicKey,
    pool,
    swapBaseForQuote: false,
    swapMode: swapMode as SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
    referralTokenAccount: null,
  })
  await sendTransaction(connection, swapTx, [buyer], 'buy')

  console.log('\nDone. Run `npm run status` to see the new curve progress.')
}

main().catch((error: unknown) => {
  console.error(`\nBuy failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
