import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey } from '@solana/web3.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { routeLeftover } from './lib/leftover.js'
import { loadLaunch } from './lib/store.js'

const CREATED_POOL = 3
const PROGRESS_LABELS = ['PreBondingCurve', 'PostBondingCurve', 'LockedVesting', 'CreatedPool']

/** How often --watch checks whether the pool has migrated. */
const POLL_SECONDS = 5

/**
 * Sends the leftover to LEFTOVER_COMMUNITY_WALLET and LEFTOVER_TREASURY_WALLET.
 *
 * The program releases the leftover only once the DAMM v2 pool exists, and from
 * that moment anyone may withdraw it, unsplit, to the partner wallet. On mainnet
 * a keeper usually migrates, at a time nobody announces, so --watch polls the
 * pool and routes the leftover as soon as the migration lands.
 *
 * Nothing else happens here. Fees are `claim`'s job, so a failing fee claim can
 * never hold the leftover back.
 */
async function main(): Promise<void> {
  const { communityWallet, treasuryWallet, communityAmount, treasuryAmount } = config.leftoverSplit
  if (!communityWallet || !treasuryWallet) {
    throw new Error('LEFTOVER_COMMUNITY_WALLET and LEFTOVER_TREASURY_WALLET are not set: there is nowhere to send the leftover.')
  }

  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const launch = loadLaunch(config.token.symbol)
  const pool = new PublicKey(launch.pool)
  const watch = process.argv.includes('--watch')

  console.log(`${launch.name} (${launch.symbol})`)
  console.log(`  pool       ${launch.pool}`)
  console.log(`  community  ${communityAmount.toLocaleString('en-US')} → ${communityWallet.toBase58()}`)
  console.log(`  treasury   ${treasuryAmount.toLocaleString('en-US')} → ${treasuryWallet.toBase58()}\n`)

  // The partner wallet is the leftover receiver: it signs the split, and pays
  // the fee and the rent of the two destination token accounts.
  const partner = loadKeypair(config.wallets.partner)
  const creator = loadKeypair(config.wallets.creator)
  await assertFunded(connection, partner, 0.01, 'Partner')

  let lastProgress: number | null = null
  for (;;) {
    let progress: number
    try {
      const poolState = await client.state.getPool(pool)
      if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)
      progress = poolState.poolState.migrationProgress
    } catch (error) {
      if (!watch) throw error
      // A long watch outlives the odd RPC hiccup; the next poll retries.
      console.log(`  ${new Date().toLocaleTimeString()}  ${error instanceof Error ? error.message : String(error)}, retrying`)
      await sleep(POLL_SECONDS)
      continue
    }

    if (progress === CREATED_POOL) {
      if (lastProgress !== null) console.log(`  ${new Date().toLocaleTimeString()}  migrated\n`)
      await routeLeftover(connection, client, launch, [partner, creator])
      return
    }

    const label = PROGRESS_LABELS[progress] ?? String(progress)
    if (!watch) {
      console.log(`Not migrated yet (${label}): the leftover can only be withdrawn once the DAMM v2 pool exists.`)
      console.log('Run `launchpad leftover --watch` to send it the moment the pool migrates.')
      process.exitCode = 1
      return
    }
    if (progress !== lastProgress) {
      console.log(`  ${new Date().toLocaleTimeString()}  ${label}, checking every ${POLL_SECONDS}s until the pool migrates`)
      lastProgress = progress
    }
    await sleep(POLL_SECONDS)
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

main().catch((error: unknown) => {
  console.error(`\nLeftover failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
