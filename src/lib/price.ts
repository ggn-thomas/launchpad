import { NATIVE_MINT } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'

const COINGECKO_IDS: Record<string, string> = {
  [NATIVE_MINT.toBase58()]: 'solana',
}

/**
 * Spot USD price for a quote mint, or null when it cannot be determined.
 *
 * Used for display only, so a failed lookup degrades to showing raw token
 * amounts rather than blocking. Never let a price feed decide anything the
 * program will act on — the config is denominated in the quote token.
 */
export async function quotePriceUsd(quoteMint: PublicKey): Promise<number | null> {
  const id = COINGECKO_IDS[quoteMint.toBase58()]
  if (!id) return null

  try {
    const response = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, { usd?: number }>
    const price = body[id]?.usd
    return typeof price === 'number' && price > 0 ? price : null
  } catch {
    return null
  }
}

export function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}
