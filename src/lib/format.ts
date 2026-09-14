import type BN from 'bn.js'

/**
 * Formats a raw amount with its unit. A non-zero balance never renders as "0" —
 * that reads as nothing to claim while the script goes ahead and claims it.
 */
export function amount(raw: BN, decimals: number, unit: string): string {
  const value = Number(raw.toString()) / 10 ** decimals
  if (value > 0 && value < 0.000001) return `${raw.toString()} base units of ${unit}`
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`
}
