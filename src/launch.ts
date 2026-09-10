import { Keypair } from '@solana/web3.js'
import {
  deriveDbcPoolAddress,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { buildLaunchCurve, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { saveLaunch } from './lib/store.js'
import { explorerAddress, sendTransaction } from './lib/tx.js'

async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')

  const partner = loadKeypair(config.wallets.partner)
  const creator = loadKeypair(config.wallets.creator)
  const soloLaunch = partner.publicKey.equals(creator.publicKey)

  console.log(`RPC      ${config.rpcUrl}`)
  console.log(`Partner  ${partner.publicKey.toBase58()}`)
  console.log(`Creator  ${creator.publicKey.toBase58()}${soloLaunch ? ' (same wallet)' : ''}`)
  console.log(`Token    ${config.token.name} (${config.token.symbol})`)
  console.log(
    `Curve    ${config.curve.initialMarketCap} -> ${config.curve.migrationMarketCap} ${QUOTE_LABEL} market cap\n`,
  )
  console.log('Run `npm run preview` for the full supply and fee breakdown.\n')

  // Rent for the config and mint accounts, plus the first buy, plus fees.
  await assertFunded(connection, partner, 0.1, 'Partner')
  if (!soloLaunch) await assertFunded(connection, creator, config.trading.firstBuy + 0.1, 'Creator')

  // 1. The config holds the curve and fee rules. One config can back many pools,
  //    but a single-token launch creates its own.
  const curveConfig = buildLaunchCurve()
  const configKeypair = Keypair.generate()

  console.log('Creating config...')
  const createConfigTx = await client.partner.createConfig({
    ...curveConfig,
    config: configKeypair.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint: config.quote.mint,
    payer: partner.publicKey,
  })
  await sendTransaction(connection, createConfigTx, [partner, configKeypair], 'create config')

  // 2. Creating the pool mints the token and opens the bonding curve. The first
  //    buy rides in the same transaction, so nobody can snipe the opening price.
  const baseMint = Keypair.generate()
  const firstBuyRaw = new BN(Math.round(config.trading.firstBuy * 10 ** QUOTE_DECIMALS))

  console.log(`Creating pool with a ${config.trading.firstBuy} ${QUOTE_LABEL} first buy...`)
  const createPoolTx = await client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      baseMint: baseMint.publicKey,
      config: configKeypair.publicKey,
      name: config.token.name,
      symbol: config.token.symbol,
      uri: config.token.uri,
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
    },
    firstBuyParam: {
      buyer: creator.publicKey,
      buyAmount: firstBuyRaw,
      // The pool does not exist yet, so there is nothing to quote against. This
      // buy opens the curve at the configured start price inside the same
      // transaction, leaving no window for anyone to move the price first.
      minimumAmountOut: new BN(0),
      referralTokenAccount: null,
    },
  })

  const poolSigners = soloLaunch ? [creator, baseMint] : [creator, baseMint, partner]
  await sendTransaction(connection, createPoolTx, poolSigners, 'create pool + first buy')

  const pool = deriveDbcPoolAddress(config.quote.mint, baseMint.publicKey, configKeypair.publicKey)

  const recordPath = saveLaunch({
    cluster: config.rpcUrl,
    name: config.token.name,
    symbol: config.token.symbol,
    config: configKeypair.publicKey.toBase58(),
    baseMint: baseMint.publicKey.toBase58(),
    pool: pool.toBase58(),
    partner: partner.publicKey.toBase58(),
    creator: creator.publicKey.toBase58(),
    launchedAt: new Date().toISOString(),
  })

  console.log(`\nLaunched ${config.token.symbol}`)
  console.log(`  mint    ${baseMint.publicKey.toBase58()}`)
  console.log(`  pool    ${pool.toBase58()}`)
  console.log(`  config  ${configKeypair.publicKey.toBase58()}`)
  console.log(`  ${explorerAddress(baseMint.publicKey.toBase58())}`)
  console.log(`\nSaved to ${recordPath}`)
  console.log(`Next: npm run status  |  npm run buy`)
}

main().catch((error: unknown) => {
  console.error(`\nLaunch failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
