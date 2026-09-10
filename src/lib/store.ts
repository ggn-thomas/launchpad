import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LAUNCH_DIR = resolve(process.cwd(), '.launch')

/** What a completed launch produces, and what `buy` / `status` need to find it again. */
export type LaunchRecord = {
  cluster: string
  name: string
  symbol: string
  config: string
  baseMint: string
  pool: string
  partner: string
  creator: string
  launchedAt: string
}

function recordPath(symbol: string): string {
  return resolve(LAUNCH_DIR, `${symbol.toLowerCase()}.json`)
}

export function saveLaunch(record: LaunchRecord): string {
  mkdirSync(LAUNCH_DIR, { recursive: true })
  const path = recordPath(record.symbol)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  return path
}

export function loadLaunch(symbol: string): LaunchRecord {
  const path = recordPath(symbol)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LaunchRecord
  } catch {
    throw new Error(`No launch record at ${path}. Run \`npm run launch\` first.`)
  }
}
