import {
  ActivationType,
  buildCurveWithMarketCap,
  getTokenomics,
  MigrationOption,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Decimal } from 'decimal.js'
import BN from 'bn.js'
import { config } from './env.js'

export const BASE_DECIMALS = config.token.decimals
export const QUOTE_DECIMALS = config.quote.decimals
export const QUOTE_LABEL = config.quote.label

/**
 * Assembles the on-chain config parameters from .env.
 *
 * Two structural choices are not exposed as keys because the SDK leaves no real
 * alternative: migration targets DAMM v2 (v1 is deprecated for new configs) and
 * activation is timestamp-based, which is what makes FEE_DECAY_SECONDS seconds.
 *
 * The curve builder is the other one. `buildCurveWithMarketCap` derives a
 * single-segment curve from the two market caps; swapping it here reshapes the
 * curve without touching .env:
 *   - `buildCurveWithLiquidityWeights` — same inputs plus a weights array.
 *   - `buildCurveWithTwoSegments`      — two phases split by supply share.
 *   - `buildCurveWithCustomSqrtPrices` — explicit checkpoints, up to 16.
 */
export function buildLaunchCurve(): ConfigParameters {
  const { token, fee, migration, liquidity, vesting, curve } = config

  return buildCurveWithMarketCap({
    token: {
      tokenType: token.programType,
      tokenBaseDecimal: token.decimals,
      tokenQuoteDecimal: config.quote.decimals,
      tokenAuthorityOption: token.authority,
      totalTokenSupply: token.totalSupply,
      leftover: token.leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: fee.decayMode,
        feeSchedulerParam: {
          startingFeeBps: fee.startBps,
          endingFeeBps: fee.endBps,
          numberOfPeriod: fee.decayPeriods,
          totalDuration: fee.decaySeconds,
        },
      },
      dynamicFeeEnabled: fee.dynamicEnabled,
      collectFeeMode: fee.collectIn,
      creatorTradingFeePercentage: fee.creatorPct,
      poolCreationFee: fee.poolCreation,
      enableFirstSwapWithMinFee: fee.firstSwapMinFee,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: migration.feeOption,
      migrationFee: {
        feePercentage: migration.feePct,
        creatorFeePercentage: migration.creatorFeePct,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: liquidity.partnerPct,
      partnerPermanentLockedLiquidityPercentage: liquidity.partnerLockedPct,
      creatorLiquidityPercentage: liquidity.creatorPct,
      creatorPermanentLockedLiquidityPercentage: liquidity.creatorLockedPct,
    },
    lockedVesting: {
      totalLockedVestingAmount: vesting.amount,
      numberOfVestingPeriod: vesting.periods,
      cliffUnlockAmount: vesting.cliffAmount,
      totalVestingDuration: vesting.durationSeconds,
      cliffDurationFromMigrationTime: vesting.cliffSeconds,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: curve.initialMarketCap,
    migrationMarketCap: curve.migrationMarketCap,
  })
}

export type SupplyBreakdown = {
  bondingCurve: BN
  migration: BN
  leftover: BN
  lockedVesting: BN
  total: BN
}

/**
 * How the total supply splits across the four buckets the program tracks.
 * `leftover` and `lockedVesting` are independent allocations, not two views of
 * the same tokens, which is worth seeing before signing a launch.
 */
export function supplyBreakdown(): SupplyBreakdown {
  const scale = new BN(10).pow(new BN(config.token.decimals))
  const toRaw = (amount: number) => new BN(amount).mul(scale)

  const tokenomics = getTokenomics(
    new Decimal(config.curve.initialMarketCap),
    new Decimal(config.curve.migrationMarketCap),
    toRaw(config.vesting.amount),
    toRaw(config.token.leftover),
    toRaw(config.token.totalSupply),
  )

  return {
    bondingCurve: tokenomics.bondingCurveSupply,
    migration: tokenomics.migrationSupply,
    leftover: tokenomics.leftoverSupply,
    lockedVesting: tokenomics.lockedVestingSupply,
    total: toRaw(config.token.totalSupply),
  }
}
