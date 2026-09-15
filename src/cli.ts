/**
 * Command dispatch for the `launchpad` binary.
 *
 * Each command is a module that runs on import, so dispatching is a dynamic
 * import. Nothing here duplicates the scripts' logic, and `npm run <command>`
 * keeps working unchanged.
 */
type Command = { module: string; summary: string }

/** Ordered as a launch actually runs, so `launchpad` doubles as a reminder. */
const COMMANDS: Record<string, Command> = {
  metadata: { module: './metadata.js', summary: 'Generate metadata/token.json from .env' },
  preview: { module: './preview.js', summary: 'Validate and price the launch — signs nothing' },
  'pre-launch': { module: './pre-launch.js', summary: 'Draw the config key, mint and pool addresses — sends nothing' },
  launch: { module: './launch.js', summary: 'Create the config, mint the token, open the curve' },
  buy: { module: './buy.js', summary: 'Quote and execute a swap on the curve' },
  sell: { module: './sell.js', summary: 'Sell the token back to the curve for quote' },
  status: { module: './status.js', summary: 'Curve progress, price and fees earned' },
  claim: { module: './claim.js', summary: 'Collect curve trading fees, surplus and migration fees' },
  migrate: { module: './migrate.js', summary: 'Graduate a completed curve to DAMM v2' },
  leftover: { module: './leftover.js', summary: 'Send the leftover to the split wallets (--watch waits for migration)' },
  'claim-pool': { module: './claim-pool.js', summary: 'Collect DAMM v2 pool fees after migration' },
}

function usage(): void {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  console.log('launchpad <command>\n')
  console.log('Commands, in the order a launch runs:\n')
  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width)}  ${summary}`)
  }
  console.log('\nReads .env and writes .launch/ in the current directory.')
}

const [name] = process.argv.slice(2)

if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
  usage()
  process.exit(name === undefined ? 1 : 0)
}

const command = COMMANDS[name]
if (!command) {
  console.error(`Unknown command "${name}".\n`)
  usage()
  process.exit(1)
}

await import(command.module)
