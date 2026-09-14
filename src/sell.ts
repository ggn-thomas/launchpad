import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  DynamicBondingCurveClient,
  getCurrentPoint,
  getTokenProgram,
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

  // A sell only needs network fees. When the quote is SOL, the wrapped SOL
  // account is opened and closed in the same transaction, so its rent comes back.
  const seller = loadKeypair(config.wallets.creator)
  await assertFunded(connection, seller, 0.01, 'Seller')

  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)

  // A VirtualPool wraps the on-chain account fields under `poolState`.
  const { poolState: poolAccount } = poolState
  const configState = await client.state.getPoolConfig(poolAccount.config)
  if (!configState) throw new Error(`Config ${poolAccount.config.toBase58()} not found`)

  // The program rejects every swap once the raise hits the migration threshold.
  if (poolAccount.quoteReserve.gte(configState.migrationQuoteThreshold)) {
    throw new Error(
      poolAccount.isMigrated === 1
        ? 'The curve has migrated: the token now trades on the DAMM v2 pool, not on the curve.'
        : 'The curve is complete and no longer trades. Run `npm run migrate` to open the DAMM v2 pool.',
    )
  }

  const baseMint = new PublicKey(launch.baseMint)
  const tokenAccount = getAssociatedTokenAddressSync(
    baseMint,
    seller.publicKey,
    false,
    getTokenProgram(configState.tokenType),
  )
  // A wallet that never bought has no token account, which reads as a zero balance.
  const balance = await connection.getTokenAccountBalance(tokenAccount).then(
    ({ value }) => new BN(value.amount),
    () => new BN(0),
  )
  if (balance.isZero()) {
    throw new Error(`Wallet ${seller.publicKey.toBase58()} holds no ${launch.symbol} to sell.`)
  }

  // toFixed goes through a string, so large supplies with 9 decimals keep every
  // digit instead of losing them to floating point.
  const { sellAmount } = config.trading
  const amountIn =
    sellAmount === 'all' ? balance : new BN(sellAmount.toFixed(BASE_DECIMALS).replace('.', ''))

  if (amountIn.isZero()) {
    throw new Error(`SELL_AMOUNT ${sellAmount} rounds to 0 at ${BASE_DECIMALS} decimals.`)
  }
  if (amountIn.gt(balance)) {
    throw new Error(
      `SELL_AMOUNT is ${sellAmount} ${launch.symbol}, but the wallet only holds ` +
        `${toUi(balance, BASE_DECIMALS)}. Lower it or set SELL_AMOUNT=all.`,
    )
  }

  // The fee schedule is evaluated against the chain's current point, which is a
  // slot or a timestamp depending on the config.
  const currentPoint = await getCurrentPoint(connection, configState.activationType)

  const quote = client.pool.swapQuote2({
    virtualPool: poolState,
    config: configState,
    swapBaseForQuote: true,
    swapMode: SwapMode.ExactIn,
    amountIn,
    slippageBps: config.trading.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  })

  const { minimumAmountOut } = quote
  if (!minimumAmountOut) throw new Error('Quote returned no minimumAmountOut')

  // On a sell the output is the quote token, so the fee lands in quote whichever
  // COLLECT_FEE_MODE is set.
  console.log(
    `Selling ${toUi(amountIn, BASE_DECIMALS)} ${launch.symbol}` +
      `${sellAmount === 'all' ? ' (whole balance)' : ''}`,
  )
  console.log(`  expected  ${toUi(quote.outputAmount, QUOTE_DECIMALS)} ${QUOTE_LABEL}`)
  console.log(`  minimum   ${toUi(minimumAmountOut, QUOTE_DECIMALS)} ${QUOTE_LABEL} at ${config.trading.slippageBps} bps slippage`)
  console.log(`  trade fee ${toUi(quote.tradingFee, QUOTE_DECIMALS)} ${QUOTE_LABEL}`)

  const swapTx = await client.pool.swap2({
    owner: seller.publicKey,
    payer: seller.publicKey,
    pool,
    swapBaseForQuote: true,
    swapMode: SwapMode.ExactIn,
    amountIn,
    minimumAmountOut,
    referralTokenAccount: null,
  })
  await sendTransaction(connection, swapTx, [seller], 'sell')

  console.log('\nDone. Run `npm run status` to see the new curve progress.')
}

main().catch((error: unknown) => {
  console.error(`\nSell failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
