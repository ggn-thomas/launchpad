import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { NATIVE_MINT } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import {
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import 'dotenv/config'

/**
 * Every launch parameter lives in .env — this file is the only thing that reads
 * it. Values are parsed and validated once, here, so a typo fails on startup
 * with a message naming the key rather than surfacing as a rejected transaction
 * or, worse, a launch with the wrong economics.
 *
 * Point DOTENV_CONFIG_PATH at another file to keep several launches side by
 * side: `DOTENV_CONFIG_PATH=.env.mainnet npm run preview`.
 */

class ConfigError extends Error {
  constructor(key: string, problem: string) {
    super(`${key}: ${problem}`)
    this.name = 'ConfigError'
  }
}

function raw(key: string): string | undefined {
  const value = process.env[key]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function str(key: string): string {
  const value = raw(key)
  if (value === undefined) throw new ConfigError(key, 'required, but missing from .env')
  return value
}

function num(key: string, fallback?: number): number {
  const value = raw(key)
  if (value === undefined) {
    if (fallback === undefined) throw new ConfigError(key, 'required, but missing from .env')
    return fallback
  }
  const parsed = Number(value.replaceAll('_', ''))
  if (!Number.isFinite(parsed)) throw new ConfigError(key, `expected a number, got "${value}"`)
  return parsed
}

function int(key: string, fallback?: number): number {
  const value = num(key, fallback)
  if (!Number.isInteger(value)) throw new ConfigError(key, `expected a whole number, got ${value}`)
  return value
}

function pct(key: string, fallback?: number): number {
  const value = num(key, fallback)
  if (value < 0 || value > 100) throw new ConfigError(key, `expected 0-100, got ${value}`)
  return value
}

function bool(key: string, fallback: boolean): boolean {
  const value = raw(key)?.toLowerCase()
  if (value === undefined) return fallback
  if (['true', 'yes', '1', 'on'].includes(value)) return true
  if (['false', 'no', '0', 'off'].includes(value)) return false
  throw new ConfigError(key, `expected true or false, got "${value}"`)
}

/** Maps a friendly .env string onto an SDK enum, listing valid values on a miss. */
function choice<T>(key: string, options: Record<string, T>, fallback?: string): T {
  const value = (raw(key) ?? fallback)?.toLowerCase()
  if (value === undefined) throw new ConfigError(key, 'required, but missing from .env')
  const match = options[value]
  if (match === undefined) {
    throw new ConfigError(key, `unknown value "${value}". Valid: ${Object.keys(options).join(', ')}`)
  }
  return match
}

/** Quote tokens by name, so the mint and its decimals can never disagree. */
const QUOTE_TOKENS = {
  sol: { mint: NATIVE_MINT, decimals: TokenDecimal.NINE, label: 'SOL' },
  usdc: {
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    decimals: TokenDecimal.SIX,
    label: 'USDC',
  },
  'usdc-devnet': {
    mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    decimals: TokenDecimal.SIX,
    label: 'USDC',
  },
} as const

const TOKEN_DECIMALS = { '6': TokenDecimal.SIX, '7': TokenDecimal.SEVEN, '8': TokenDecimal.EIGHT, '9': TokenDecimal.NINE }

function buildConfig() {
  const quote = choice('QUOTE_TOKEN', QUOTE_TOKENS, 'sol')

  return {
    rpcUrl: raw('RPC_URL') ?? 'https://api.devnet.solana.com',

    wallets: {
      /** Owns the config, fixed forever: it can never be reassigned after creation. */
      partner: raw('PARTNER_KEYPAIR') ?? '~/.config/solana/id.json',
      /** Creates the pool. Transferable later via transfer_pool_creator. */
      creator: raw('CREATOR_KEYPAIR') ?? raw('PARTNER_KEYPAIR') ?? '~/.config/solana/id.json',
    },

    quote,

    token: {
      name: str('TOKEN_NAME'),
      symbol: str('TOKEN_SYMBOL'),
      /** URL of the metadata JSON, not of the image. See metadata/README.md. */
      uri: str('TOKEN_URI'),
      totalSupply: int('TOKEN_TOTAL_SUPPLY', 1_000_000_000),
      decimals: choice('TOKEN_DECIMALS', TOKEN_DECIMALS, '6'),
      programType: choice('TOKEN_PROGRAM', { spl: TokenType.SPLToken, token2022: TokenType.Token2022 }, 'spl'),
      authority: choice(
        'TOKEN_AUTHORITY',
        {
          immutable: TokenAuthorityOption.Immutable,
          creator: TokenAuthorityOption.CreatorUpdateAuthority,
          partner: TokenAuthorityOption.PartnerUpdateAuthority,
        },
        'immutable',
      ),
      /** Unsold base tokens, handed liquid to the partner at migration. */
      leftover: int('TOKEN_LEFTOVER', 0),

      /** Everything below feeds the generated metadata JSON, not the program. */
      description: raw('TOKEN_DESCRIPTION') ?? '',
      /** URL of the uploaded logo. Upload the image first, then paste it here. */
      image: raw('TOKEN_IMAGE') ?? '',
      website: raw('TOKEN_WEBSITE') ?? '',
      twitter: raw('TOKEN_TWITTER') ?? '',
      telegram: raw('TOKEN_TELEGRAM') ?? '',
    },

    curve: {
      initialMarketCap: num('INITIAL_MARKET_CAP'),
      migrationMarketCap: num('MIGRATION_MARKET_CAP'),
    },

    fee: {
      startBps: int('TRADING_FEE_START_BPS'),
      endBps: int('TRADING_FEE_END_BPS'),
      /** Both must be 0 when the start and end fees match, giving a flat fee. */
      decayPeriods: int('FEE_DECAY_PERIODS', 0),
      /** Seconds, because activation is timestamp-based. */
      decaySeconds: int('FEE_DECAY_SECONDS', 0),
      decayMode: choice(
        'FEE_DECAY_MODE',
        { linear: BaseFeeMode.FeeSchedulerLinear, exponential: BaseFeeMode.FeeSchedulerExponential } as const,
        'linear',
      ),
      dynamicEnabled: bool('DYNAMIC_FEE', false),
      collectIn: choice(
        'COLLECT_FEE_MODE',
        { quote: CollectFeeMode.QuoteToken, output: CollectFeeMode.OutputToken },
        'quote',
      ),
      /** Share of trading fees AND post-migration surplus routed to the creator. */
      creatorPct: pct('CREATOR_FEE_PCT', 100),
      /** Charged to whoever creates a pool from this config, in quote units. */
      poolCreation: num('POOL_CREATION_FEE', 0),
      firstSwapMinFee: bool('FIRST_SWAP_MIN_FEE', false),
    },

    migration: {
      feeOption: choice(
        'MIGRATION_FEE_OPTION',
        {
          fixed_25bps: MigrationFeeOption.FixedBps25,
          fixed_30bps: MigrationFeeOption.FixedBps30,
          fixed_100bps: MigrationFeeOption.FixedBps100,
          fixed_200bps: MigrationFeeOption.FixedBps200,
          fixed_400bps: MigrationFeeOption.FixedBps400,
          fixed_600bps: MigrationFeeOption.FixedBps600,
        },
        'fixed_30bps',
      ),
      /** Your cut of the raise, taken at migration. */
      feePct: pct('MIGRATION_FEE_PCT', 0),
      creatorFeePct: pct('MIGRATION_CREATOR_FEE_PCT', 0),
    },

    /** Must total exactly 100, with at least 10 locked on day one. */
    liquidity: {
      partnerPct: pct('LP_PARTNER_PCT', 0),
      partnerLockedPct: pct('LP_PARTNER_LOCKED_PCT', 0),
      creatorPct: pct('LP_CREATOR_PCT', 0),
      creatorLockedPct: pct('LP_CREATOR_LOCKED_PCT', 100),
    },

    vesting: {
      amount: int('VESTING_AMOUNT', 0),
      periods: int('VESTING_PERIODS', 0),
      cliffAmount: int('VESTING_CLIFF_AMOUNT', 0),
      durationSeconds: int('VESTING_DURATION_S', 0),
      cliffSeconds: int('VESTING_CLIFF_S', 0),
    },

    trading: {
      /** Quote spent on the first buy, atomic with pool creation. */
      firstBuy: num('FIRST_BUY', 0.1),
      /** Quote spent by `npm run buy`. */
      buyAmount: num('BUY_AMOUNT', 0.05),
      slippageBps: int('SLIPPAGE_BPS', 100),
    },
  } as const
}

type LaunchConfig = ReturnType<typeof buildConfig>

/** Cross-field rules the per-key parsers cannot see. */
function validate(config: LaunchConfig): void {
  const lp =
    config.liquidity.partnerPct +
    config.liquidity.partnerLockedPct +
    config.liquidity.creatorPct +
    config.liquidity.creatorLockedPct
  if (lp !== 100) {
    throw new Error(
      `LP_* percentages must total exactly 100, got ${lp}. ` +
        `(partner ${config.liquidity.partnerPct} + partner locked ${config.liquidity.partnerLockedPct} + ` +
        `creator ${config.liquidity.creatorPct} + creator locked ${config.liquidity.creatorLockedPct})`,
    )
  }
  if (config.liquidity.partnerLockedPct + config.liquidity.creatorLockedPct < 10) {
    throw new Error('At least 10% of migrated liquidity must be locked: raise LP_*_LOCKED_PCT.')
  }
  if (config.fee.startBps === config.fee.endBps) {
    if (config.fee.decayPeriods !== 0 || config.fee.decaySeconds !== 0) {
      throw new Error(
        'A flat fee (TRADING_FEE_START_BPS === TRADING_FEE_END_BPS) requires ' +
          'FEE_DECAY_PERIODS and FEE_DECAY_SECONDS to both be 0.',
      )
    }
  } else {
    if (config.fee.endBps > config.fee.startBps) {
      throw new Error('TRADING_FEE_END_BPS must be at most TRADING_FEE_START_BPS.')
    }
    if (config.fee.decayPeriods <= 0 || config.fee.decaySeconds <= 0) {
      throw new Error('A decaying fee requires FEE_DECAY_PERIODS and FEE_DECAY_SECONDS above 0.')
    }
  }
  if (config.migration.feePct === 0 && config.migration.creatorFeePct !== 0) {
    throw new Error('MIGRATION_CREATOR_FEE_PCT must be 0 when MIGRATION_FEE_PCT is 0.')
  }
  if (config.curve.migrationMarketCap <= config.curve.initialMarketCap) {
    throw new Error('MIGRATION_MARKET_CAP must be above INITIAL_MARKET_CAP.')
  }
}

/**
 * Parsing and validation run once, at import. A bad .env therefore stops every
 * script with one readable line naming the key, rather than a stack trace or a
 * transaction that fails on-chain for reasons that look unrelated.
 */
function load(): LaunchConfig {
  try {
    const parsed = buildConfig()
    validate(parsed)
    return parsed
  } catch (error) {
    console.error(`\n.env is not valid\n\n  ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

export const config = load()

export function loadKeypair(path: string): Keypair {
  const expanded = path.startsWith('~') ? resolve(homedir(), path.slice(2)) : resolve(path)
  let contents: string
  try {
    contents = readFileSync(expanded, 'utf8')
  } catch {
    throw new Error(`Cannot read keypair at ${expanded}. Create one: solana-keygen new -o ${expanded}`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(contents) as number[]))
}

export function createConnection(): Connection {
  return new Connection(config.rpcUrl, 'confirmed')
}

/** Fails with an actionable message rather than mid-launch on an opaque error. */
export async function assertFunded(
  connection: Connection,
  keypair: Keypair,
  minimumSol: number,
  role: string,
): Promise<void> {
  const lamports = await connection.getBalance(keypair.publicKey)
  const sol = lamports / LAMPORTS_PER_SOL
  if (sol < minimumSol) {
    throw new Error(
      `${role} wallet ${keypair.publicKey.toBase58()} holds ${sol.toFixed(4)} SOL, ` +
        `needs at least ${minimumSol}. Fund it at https://faucet.solana.com/`,
    )
  }
}
