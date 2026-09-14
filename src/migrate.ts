import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey, type Connection, type Keypair } from '@solana/web3.js'
import { assertFunded, config, createConnection, loadKeypair } from './env.js'
import { routeLeftover } from './lib/leftover.js'
import { loadLaunch, type LaunchRecord } from './lib/store.js'
import { explorerTx, sendTransaction } from './lib/tx.js'

/** Values of `migrationProgress` on the pool account. */
const PRE_BONDING_CURVE = 0
const POST_BONDING_CURVE = 1
const LOCKED_VESTING = 2 // reached once the escrow exists; migrateToDammV2 is valid from here
const CREATED_POOL = 3

const PROGRESS_LABELS = ['PreBondingCurve', 'PostBondingCurve', 'LockedVesting', 'CreatedPool']

/**
 * Graduates a completed pool into DAMM v2.
 *
 * Migration is permissionless — the caller only pays the fees — which is what
 * lets Meteora run keepers for it on mainnet. Those keepers only pick up pools
 * raising 10+ SOL, 750+ USDC or 1500+ JUP, and none run on devnet, so this
 * script covers everything below that bar plus all devnet testing.
 */
async function main(): Promise<void> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const launch = loadLaunch(config.token.symbol)

  const payer = loadKeypair(config.wallets.creator)
  await assertFunded(connection, payer, 0.05, 'Payer')

  const pool = new PublicKey(launch.pool)
  const poolState = await client.state.getPool(pool)
  if (!poolState) throw new Error(`Pool ${launch.pool} not found on ${config.rpcUrl}`)

  const progress = poolState.poolState.migrationProgress
  console.log(`${launch.name} (${launch.symbol})`)
  console.log(`  pool     ${launch.pool}`)
  console.log(`  state    ${PROGRESS_LABELS[progress] ?? progress}\n`)

  if (progress === PRE_BONDING_CURVE) {
    throw new Error('The curve has not completed yet. Run `npm run status` to see how far it is.')
  }
  if (progress === CREATED_POOL) {
    console.log('Already migrated.')
    await leftoverAfterMigration(connection, client, launch, payer)
    return
  }

  // A pool with locked vesting stops at PostBondingCurve until its escrow
  // exists; without vesting it lands straight on LockedVesting and skips this.
  if (progress === POST_BONDING_CURVE) {
    console.log('Creating the vesting locker...')
    const lockerTx = await client.migration.createLocker({ payer: payer.publicKey, pool })
    await sendTransaction(connection, lockerTx, [payer], 'create locker')
  }

  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migration.feeOption]
  if (!dammConfig) {
    throw new Error(`No DAMM v2 config for MIGRATION_FEE_OPTION index ${config.migration.feeOption}`)
  }

  console.log(`Migrating to DAMM v2 (config ${dammConfig.toBase58()})...`)
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } =
    await client.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig })

  // The migrated liquidity is held as position NFTs, minted in this same
  // transaction, so their keypairs have to sign it.
  const signature = await sendTransaction(
    connection,
    transaction,
    [payer, firstPositionNftKeypair, secondPositionNftKeypair],
    'migrate to DAMM v2',
  )

  console.log(`\nMigrated ${launch.symbol}`)
  console.log(`  position 1  ${firstPositionNftKeypair.publicKey.toBase58()}`)
  console.log(`  position 2  ${secondPositionNftKeypair.publicKey.toBase58()}`)
  console.log(`  ${explorerTx(signature)}`)
  console.log('\nTrading now happens on the DAMM v2 pool. `npm run status` still reads the DBC record.')

  await leftoverAfterMigration(connection, client, launch, payer)
}

/**
 * The leftover becomes withdrawable the moment the DAMM v2 pool exists, and
 * from then on anyone may withdraw it to the partner wallet, unsplit. Routing
 * it right away keeps that window as short as this script can make it.
 *
 * The migration has landed by this point, so a failure here must not read as a
 * failed migration: it is reported, and `claim` retries it.
 */
async function leftoverAfterMigration(
  connection: Connection,
  client: DynamicBondingCurveClient,
  launch: LaunchRecord,
  payer: Keypair,
): Promise<void> {
  if (config.token.leftover === 0) return
  console.log('\nLeftover')
  try {
    await routeLeftover(connection, client, launch, [loadKeypair(config.wallets.partner), payer])
  } catch (error) {
    console.log(`  not routed: ${error instanceof Error ? error.message : String(error)}`)
    console.log('  The pool is migrated regardless. Run `launchpad claim` to retry the leftover.')
  }
}

main().catch((error: unknown) => {
  console.error(`\nMigration failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
