import { Keypair } from '@solana/web3.js'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { config } from './env.js'
import { launchKeysPath, loadLaunchKeys, saveLaunchKeys } from './lib/store.js'

/**
 * Fixes the launch addresses before anything is sent.
 *
 * The config and the mint are keypairs the launch signs with, and the pool is a
 * PDA of the two, so all three are known before the first transaction. Drawing
 * them here lets the mint and pool be announced or allow-listed ahead of time;
 * `launch` then signs with these exact keypairs. Signs nothing, sends nothing.
 *
 * Running it again prints the same addresses. `--new` draws fresh ones, which
 * orphans the old ones: only do that if they were never shared.
 */
function main(): void {
  const regenerate = process.argv.includes('--new')
  const symbol = config.token.symbol

  let keys = regenerate ? null : loadLaunchKeys(symbol)
  const reused = keys !== null
  if (!keys) {
    keys = {
      config: Keypair.generate(),
      baseMint: Keypair.generate(),
      quoteMint: config.quote.mint,
      createdAt: new Date().toISOString(),
    }
  } else if (!keys.quoteMint.equals(config.quote.mint)) {
    // Same config and mint, but the pool PDA moves with the quote mint.
    console.log(`QUOTE_TOKEN changed since ${keys.createdAt}: the pool address below replaces the old one.\n`)
    keys.quoteMint = config.quote.mint
  }
  const path = saveLaunchKeys(symbol, keys)

  const pool = deriveDbcPoolAddress(config.quote.mint, keys.baseMint.publicKey, keys.config.publicKey)

  console.log(`${config.token.name} (${symbol})  quoted in ${config.quote.label}\n`)
  console.log(`  config key  ${keys.config.publicKey.toBase58()}`)
  console.log(`  base mint   ${keys.baseMint.publicKey.toBase58()}`)
  console.log(`  pool        ${pool.toBase58()}`)
  console.log(
    `\n${reused ? `Reused the keys drawn at ${keys.createdAt}` : 'New keys'}, saved to ${path}` +
      `\nNothing is on chain yet. \`launchpad launch\` signs with these exact keys.`,
  )
  if (!reused) console.log('Keep that file: without it the launch cannot use these addresses.')
}

try {
  main()
} catch (error: unknown) {
  console.error(`\nPre-launch failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
