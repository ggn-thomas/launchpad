import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Keypair, PublicKey } from '@solana/web3.js'

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
  /** Signature of the transaction that sent the leftover split; guards against sending it twice. */
  leftoverSplit?: string
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

/**
 * The config and mint keypairs of a launch that has not completed yet.
 *
 * Both addresses are plain keypairs the launch signs with, so they can be drawn
 * ahead of time: `pre-launch` writes them, `launch` signs with them and deletes
 * the file once the pool exists. The file holds secret keys, hence mode 600.
 */
export type LaunchKeys = {
  config: Keypair
  baseMint: Keypair
  /** The pool address depends on the quote mint, so a change must be caught. */
  quoteMint: PublicKey
  createdAt: string
}

type StoredKeypair = { publicKey: string; secretKey: number[] }

export function launchKeysPath(symbol: string): string {
  return resolve(LAUNCH_DIR, `${symbol.toLowerCase()}.keys.json`)
}

function storeKeypair(keypair: Keypair): StoredKeypair {
  return { publicKey: keypair.publicKey.toBase58(), secretKey: Array.from(keypair.secretKey) }
}

function restoreKeypair(stored: StoredKeypair, path: string): Keypair {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(stored.secretKey))
  if (keypair.publicKey.toBase58() !== stored.publicKey) {
    throw new Error(`${path} is corrupted: a secret key does not match its public key.`)
  }
  return keypair
}

export function saveLaunchKeys(symbol: string, keys: LaunchKeys): string {
  mkdirSync(LAUNCH_DIR, { recursive: true })
  const path = launchKeysPath(symbol)
  const stored = {
    config: storeKeypair(keys.config),
    baseMint: storeKeypair(keys.baseMint),
    quoteMint: keys.quoteMint.toBase58(),
    createdAt: keys.createdAt,
  }
  writeFileSync(path, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 })
  return path
}

export function loadLaunchKeys(symbol: string): LaunchKeys | null {
  const path = launchKeysPath(symbol)
  if (!existsSync(path)) return null
  const stored = JSON.parse(readFileSync(path, 'utf8')) as {
    config: StoredKeypair
    baseMint: StoredKeypair
    quoteMint: string
    createdAt: string
  }
  return {
    config: restoreKeypair(stored.config, path),
    baseMint: restoreKeypair(stored.baseMint, path),
    quoteMint: new PublicKey(stored.quoteMint),
    createdAt: stored.createdAt,
  }
}

export function deleteLaunchKeys(symbol: string): void {
  rmSync(launchKeysPath(symbol), { force: true })
}
