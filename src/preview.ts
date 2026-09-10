import { buildCurveWithMarketCap, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import type BN from 'bn.js'
import { BASE_DECIMALS, buildLaunchCurve, QUOTE_DECIMALS, QUOTE_LABEL, supplyBreakdown } from './curve.js'
import { Keypair } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { config, createConnection, loadKeypair } from './env.js'
import { quotePriceUsd, usd } from './lib/price.js'
import { checkTokenUri } from './lib/metadata.js'

/**
 * Asks the program itself whether this config is valid.
 *
 * The supply rules are subtle — a zero leftover combined with a non-zero
 * migration fee is rejected, for instance — so rather than reimplement them
 * here and risk drifting from the program, build the real instruction and
 * simulate it. Nothing is signed or sent.
 */
async function validateAgainstProgram(): Promise<string> {
  const connection = createConnection()
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const partner = loadKeypair(config.wallets.partner)
  const configKeypair = Keypair.generate()

  const tx = await client.partner.createConfig({
    ...buildLaunchCurve(),
    config: configKeypair.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint: config.quote.mint,
    payer: partner.publicKey,
  })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = partner.publicKey
  tx.sign(partner, configKeypair)

  const simulation = await connection.simulateTransaction(tx)
  if (!simulation.value.err) return 'accepted'
  const anchorError = simulation.value.logs?.find((line) => line.includes('Error Code'))
  return anchorError?.replace(/^Program log: /, '') ?? JSON.stringify(simulation.value.err)
}

/** Keeper thresholds that decide whether a completed pool migrates on its own. */
const KEEPER_SOL_THRESHOLD = 10

function tokens(raw: BN): string {
  return (Number(raw.toString()) / 10 ** BASE_DECIMALS).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })
}

function share(raw: BN, total: BN): string {
  const pct = (Number(raw.toString()) / Number(total.toString())) * 100
  return `${pct.toFixed(2).padStart(6)}%`
}

function quote(raw: BN): number {
  return Number(raw.toString()) / 10 ** QUOTE_DECIMALS
}

async function main(): Promise<void> {
  const curveConfig = buildLaunchCurve()
  const supply = supplyBreakdown()

  const threshold = quote(curveConfig.migrationQuoteThreshold)
  const startPrice = getPriceFromSqrtPrice(curveConfig.sqrtStartPrice, BASE_DECIMALS, QUOTE_DECIMALS)
  const isSol = QUOTE_LABEL === 'SOL'
  const unit = QUOTE_LABEL

  console.log(`${config.token.name} (${config.token.symbol})  quoted in ${unit}\n`)

  console.log('Supply')
  const rows: [string, BN][] = [
    ['bonding curve', supply.bondingCurve],
    ['migration liquidity', supply.migration],
    ['leftover (liquid at migration)', supply.leftover],
    ['locked vesting (treasury)', supply.lockedVesting],
  ]
  for (const [label, raw] of rows) {
    console.log(`  ${label.padEnd(32)} ${tokens(raw).padStart(15)}  ${share(raw, supply.total)}`)
  }
  console.log(`  ${'total'.padEnd(32)} ${tokens(supply.total).padStart(15)}`)
  console.log()

  // Priced live rather than from a comment, so the dollar figures cannot go
  // stale between writing the profile and launching it.
  const rate = await quotePriceUsd(config.quote.mint)
  const inUsd = (amount: number) => (rate === null ? '' : `  (${usd(amount * rate)})`)

  console.log('Curve')
  console.log(
    `  market cap        ${config.curve.initialMarketCap} -> ${config.curve.migrationMarketCap} ${unit}` +
      `${rate === null ? '' : `  (${usd(config.curve.initialMarketCap * rate)} -> ${usd(config.curve.migrationMarketCap * rate)})`}`,
  )
  console.log(`  start price       ${startPrice.toSignificantDigits(6).toString()} ${unit}`)
  console.log(`  raise to graduate ${threshold.toFixed(3)} ${unit}${inUsd(threshold)}`)
  console.log(`  curve segments    ${curveConfig.curve.length}`)
  console.log(
    rate === null
      ? `  spot rate         unavailable — dollar figures omitted\n`
      : `  spot rate         ${usd(rate)} per ${unit}, live from CoinGecko\n`,
  )

  console.log('Fees')
  console.log(
    config.fee.startBps === config.fee.endBps
      ? `  trading           ${config.fee.startBps / 100}% flat`
      : `  trading           ${config.fee.startBps / 100}% -> ${config.fee.endBps / 100}% over ${config.fee.decaySeconds}s`,
  )
  const creatorShare = config.fee.creatorPct
  console.log(
    `  creator share     ${creatorShare}% of trading fees and surplus` +
      `${creatorShare < 100 ? `, ${100 - creatorShare}% to partner` : ''}`,
  )
  console.log(`  migration fee     ${config.migration.feePct}% of the raise`)
  console.log(
    `  your cut          ~${((threshold * config.migration.feePct) / 100).toFixed(3)} ${unit} at migration\n`,
  )

  console.log('Migration')
  const locked = config.liquidity.partnerLockedPct + config.liquidity.creatorLockedPct
  console.log(`  permanently locked liquidity  ${locked}%`)
  if (isSol && threshold < KEEPER_SOL_THRESHOLD) {
    console.log(
      `  keeper auto-migration         NO — needs a ${KEEPER_SOL_THRESHOLD} ${unit} raise, this is ${threshold.toFixed(2)}`,
    )
  } else if (isSol) {
    console.log(`  keeper auto-migration         yes`)
  }

  // Metadata is immutable on the mainnet profile, so a bad URI is permanent.
  const metadata = await checkTokenUri(config.token.uri, {
    name: config.token.name,
    symbol: config.token.symbol,
  })
  console.log(`Metadata  ${config.token.uri}`)
  for (const line of metadata.lines) console.log(line)

  const verdict = await validateAgainstProgram()
  console.log(`\nProgram validation on ${config.rpcUrl}`)
  console.log(`  create_config  ${verdict}`)
}

main().catch((error: unknown) => {
  console.error(`\nPreview failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
