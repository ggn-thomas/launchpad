import { Keypair, type PublicKey } from '@solana/web3.js'
import {
  deriveDbcPoolAddress,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { buildLaunchCurve, QUOTE_DECIMALS, QUOTE_LABEL } from './curve.js'
import { deleteLaunchKeys, loadLaunchKeys, saveLaunch, saveLaunchKeys, type LaunchKeys } from './lib/store.js'
import { explorerAddress, sendTransaction } from './lib/tx.js'

async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')

  const partner = loadKeypair(config.wallets.partner)
  const creator = loadKeypair(config.wallets.creator)
  const soloLaunch = partner.publicKey.equals(creator.publicKey)
  const symbol = config.token.symbol

  // The keys drawn by `pre-launch`, so the announced addresses are the ones
  // created. Without them, draw fresh ones and save them before sending
  // anything: a launch that fails between its two transactions then retries on
  // the config it already paid for.
  const preLaunched = loadLaunchKeys(symbol)
  if (preLaunched && !preLaunched.quoteMint.equals(config.quote.mint)) {
    throw new Error(
      'QUOTE_TOKEN changed since pre-launch, so the pool address it printed is not the one this launch ' +
        'would create. Run `launchpad pre-launch` again to see the new one.',
    )
  }
  const keys: LaunchKeys = preLaunched ?? {
    config: Keypair.generate(),
    baseMint: Keypair.generate(),
    quoteMint: config.quote.mint,
    createdAt: new Date().toISOString(),
  }
  if (!preLaunched) saveLaunchKeys(symbol, keys)
  const configKeypair = keys.config
  const baseMint = keys.baseMint
  const pool = deriveDbcPoolAddress(config.quote.mint, baseMint.publicKey, configKeypair.publicKey)

  console.log(`RPC      ${config.rpcUrl}`)
  console.log(`Partner  ${partner.publicKey.toBase58()}`)
  console.log(`Creator  ${creator.publicKey.toBase58()}${soloLaunch ? ' (same wallet)' : ''}`)
  console.log(`Token    ${config.token.name} (${symbol})`)
  console.log(
    `Curve    ${config.curve.initialMarketCap} -> ${config.curve.migrationMarketCap} ${QUOTE_LABEL} market cap`,
  )
  console.log(
    `Config   ${configKeypair.publicKey.toBase58()}` +
      `${preLaunched ? `  (keys saved ${preLaunched.createdAt})` : '  (drawn now: `launchpad pre-launch` gives these in advance)'}`,
  )
  console.log(`Mint     ${baseMint.publicKey.toBase58()}`)
  console.log(`Pool     ${pool.toBase58()}\n`)
  console.log('Run `npm run preview` for the full supply and fee breakdown.\n')

  // The pool and its first buy land in one transaction, so an existing pool
  // means an earlier attempt went through but was never recorded, typically a
  // confirmation that timed out.
  if (await connection.getAccountInfo(pool)) {
    console.log('The pool is already on chain: an earlier attempt landed. Recording it.')
    finish(pool, configKeypair.publicKey, baseMint.publicKey, partner.publicKey, creator.publicKey)
    return
  }

  // Rent for the config and mint accounts, plus the first buy, plus fees.
  await assertFunded(connection, partner, 0.1, 'Partner')
  if (!soloLaunch) await assertFunded(connection, creator, config.trading.firstBuy + 0.1, 'Creator')

  // 1. The config holds the curve and fee rules. One config can back many pools,
  //    but a single-token launch creates its own.
  const curveConfig = buildLaunchCurve()
  const existingConfig = await client.state.getPoolConfig(configKeypair.publicKey)

  if (existingConfig) {
    // Left by an attempt that failed before the pool. A config can never be
    // edited, so reuse it only if it pays the same partner at the same price.
    const matches =
      existingConfig.feeClaimer.equals(partner.publicKey) &&
      existingConfig.quoteMint.equals(config.quote.mint) &&
      existingConfig.sqrtStartPrice.eq(curveConfig.sqrtStartPrice) &&
      existingConfig.migrationQuoteThreshold.eq(curveConfig.migrationQuoteThreshold)
    if (!matches) {
      throw new Error(
        `Config ${configKeypair.publicKey.toBase58()} already exists from an earlier attempt, with a partner, ` +
          'quote or curve that differs from .env. Run `launchpad pre-launch --new` to launch on a fresh config.',
      )
    }
    console.log('Config already on chain from an earlier attempt, reusing it.')
  } else {
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
  }

  // 2. Creating the pool mints the token and opens the bonding curve. The first
  //    buy rides in the same transaction, so nobody can snipe the opening price.
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

  finish(pool, configKeypair.publicKey, baseMint.publicKey, partner.publicKey, creator.publicKey)
}

/** Writes the launch record, then drops the keys: once the pool exists they have nothing left to sign. */
function finish(pool: PublicKey, configKey: PublicKey, baseMint: PublicKey, partner: PublicKey, creator: PublicKey): void {
  const recordPath = saveLaunch({
    cluster: config.rpcUrl,
    name: config.token.name,
    symbol: config.token.symbol,
    config: configKey.toBase58(),
    baseMint: baseMint.toBase58(),
    pool: pool.toBase58(),
    partner: partner.toBase58(),
    creator: creator.toBase58(),
    launchedAt: new Date().toISOString(),
  })
  deleteLaunchKeys(config.token.symbol)

  console.log(`\nLaunched ${config.token.symbol}`)
  console.log(`  mint    ${baseMint.toBase58()}`)
  console.log(`  pool    ${pool.toBase58()}`)
  console.log(`  config  ${configKey.toBase58()}`)
  console.log(`  ${explorerAddress(baseMint.toBase58())}`)
  console.log(`\nSaved to ${recordPath}`)
  console.log(`Next: npm run status  |  npm run buy`)
}

main().catch((error: unknown) => {
  console.error(`\nLaunch failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
