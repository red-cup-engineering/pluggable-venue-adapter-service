import { decode } from "./abi.mjs";
import { POSITION_TYPE, ORDER_PROPS_TYPE } from "../../data/gmx/contracts.mjs";
/** GMX 30-decimal USD fixed point <-> JS numbers (display/limit arithmetic only; calldata uses BigInt). */
export const usdToE30 = (usd) => BigInt(Math.round(Number(usd) * 1e6)) * 10n ** 24n;
export const e30ToUsd = (value) => Number(BigInt(value) / 10n ** 18n) / 1e12;

/* ------------------------------------------------------------------ decoders for reads */
export function decodeAccountPositions(result) {
  const [rows] = decode([{ array: POSITION_TYPE }], result);
  return rows.map(([addresses, numbers, flags]) => ({
    account: addresses[0], market: addresses[1], collateralToken: addresses[2], sizeInUsdE30: numbers[0], sizeInTokens: numbers[1], collateralAmount: numbers[2], pendingImpactAmount: numbers[3],
    borrowingFactor: numbers[4], increasedAtTime: Number(numbers[8]), decreasedAtTime: Number(numbers[9]), isLong: flags[0], sizeUsd: e30ToUsd(numbers[0]),
  }));
}
export function decodeAccountOrders(result) {
  const [rows] = decode([{ array: ORDER_PROPS_TYPE }], result);
  return rows.map(([orderKey, [addresses, numbers, flags]]) => ({
    orderKey, account: addresses[0], receiver: addresses[1], market: addresses[5], initialCollateralToken: addresses[6], swapPath: addresses[7],
    orderType: Number(numbers[0]), sizeDeltaUsdE30: numbers[2], initialCollateralDeltaAmount: numbers[3], triggerPriceE30: numbers[4], acceptablePriceE30: numbers[5], executionFee: numbers[6],
    updatedAtTime: Number(numbers[10]), isLong: flags[0], isFrozen: flags[2],
  }));
}

/**
 * The account as one venue-neutral reading in cents, like normalizeKalshiAccount. Cash is the free stablecoin
 * (USDC) wallet balance; equity adds position collateral (at par for stablecoin collateral), GM/GLV/other
 * holdings at their stated USD value, and excludes native gas ETH (it is not tradable capital).
 * Equity remains unknown when any held position has unvalued collateral; known cash and each position's
 * own valuation remain available. Supplied USD values and normalized numerical outputs must be finite.
 * @param {{usdcAmount: number, positions?: object[], holdingsUsd?: number, nativeUsd?: number, stablecoins?: string[]}} reading
 * @returns {{cashCents: number, equityCents: number|null, freeCashCents: number, gasUsd: number, positions: object[]}}
 */
export function normalizeGmxAccount({ usdcAmount, positions = [], holdingsUsd = 0, nativeUsd = 0, stablecoins = [] } = {}) {
  if (!Number.isFinite(usdcAmount)) throw new TypeError("gmx-usdc-balance-required");
  if (!Number.isFinite(holdingsUsd)) throw new TypeError("gmx-holdings-value-required");
  if (!Number.isFinite(nativeUsd)) throw new TypeError("gmx-native-value-required");
  if (positions.some((p) => !Number.isFinite(p?.sizeUsd))) throw new TypeError("gmx-position-size-required");
  const stable = new Set(stablecoins.map((a) => a.toLowerCase()));
  const heldPositions = positions.filter((p) => p.sizeUsd > 0).map((p) => ({ market: p.market, side: p.isLong ? "long" : "short", sizeCents: Math.round(p.sizeUsd * 100), collateralToken: p.collateralToken, collateralCents: stable.has(p.collateralToken.toLowerCase()) ? Math.round((Number(p.collateralAmount) / 1e6) * 100) : null }));
  const cashCents = Math.round(usdcAmount * 100);
  const holdingsCents = Math.round(holdingsUsd * 100);
  if (!Number.isFinite(cashCents) || !Number.isFinite(holdingsCents)
    || heldPositions.some((p) => !Number.isFinite(p.sizeCents)
      || (p.collateralCents !== null && !Number.isFinite(p.collateralCents))))
    throw new RangeError("gmx-account-value-out-of-range");
  const collateralCents = heldPositions.some((p) => p.collateralCents === null)
    ? null : heldPositions.reduce((sum, p) => sum + p.collateralCents, 0);
  const equityCents = collateralCents === null ? null : cashCents + collateralCents + holdingsCents;
  if (equityCents !== null && !Number.isFinite(equityCents)) throw new RangeError("gmx-account-value-out-of-range");
  return { cashCents, equityCents, freeCashCents: cashCents, gasUsd: nativeUsd, positions: heldPositions };
}

/* ------------------------------------------------------------------ carry (funding and borrowing) */
const YEAR_MS = 365 * 86_400_000;
/** A GMX v2 rate: an annualized fraction in 30-decimal fixed point (REST /markets/info), as a JS number. */
const annualRate = (raw, label) => {
  if (raw === undefined || raw === null || raw === "") throw new TypeError(`gmx-${label}-required`);
  return Number((BigInt(raw) * 10n ** 12n) / 10n ** 30n) / 1e12;
};

/**
 * What holding a GMX v2 position costs a year, per unit of position size, from one /markets/info row.
 * The legacy Oracle REST /markets/info rates are annualized E30 fractions with positive
 * funding meaning a cost to that side. This differs from SDK getFundingFactorPerPeriod,
 * whose paying side is negative. On 2026-10-11 BTC REST fundingRateLong matched
 * fundingFactorPerSecond * 31,536,000 on arbitrum.gmxapi.io/v1 with longsPayShorts=true.
 * ETH differed slightly across independently cached snapshots. Both netRateLong values
 * matched fundingRateLong + borrowingRateLong. Do not feed SDK signed returns into this model.
 * Sources: sdk/src/utils/fees/index.ts and the two timestamped live API surfaces.
 * @param {{fundingRateLong: string, fundingRateShort: string, borrowingRateLong: string, borrowingRateShort: string, netRateLong?: string, netRateShort?: string, name?: string}} market
 */
export function gmxMarketCarry(market) {
  const funding = { long: annualRate(market?.fundingRateLong, "funding-rate-long"), short: annualRate(market?.fundingRateShort, "funding-rate-short") };
  const borrowing = { long: annualRate(market?.borrowingRateLong, "borrowing-rate-long"), short: annualRate(market?.borrowingRateShort, "borrowing-rate-short") };
  if (borrowing.long < 0 || borrowing.short < 0) throw new RangeError("gmx-borrowing-rate-negative");
  return Object.freeze({
    market: market.name ?? market.marketToken ?? null, unit: "annual fraction of position size", funding, borrowing,
    annualCost: { long: borrowing.long + funding.long, short: borrowing.short + funding.short },
    netRateReported: { long: market.netRateLong === undefined ? null : annualRate(market.netRateLong, "net-rate-long"), short: market.netRateShort === undefined ? null : annualRate(market.netRateShort, "net-rate-short") },
  });
}

/**
 * A GMX position's carry as the market game's quote fields: the cost of holding `side` at `leverage` (size /
 * collateral) for `holdingMs`, as a fraction of the collateral (market-game `carryCostFraction`, which is
 * nonnegative), and a net funding credit as its own fraction for the scenario payoff. It assumes today's rates
 * hold over the period; GMX moves them with open interest, so the quote is only as fresh as its row.
 */
export function gmxQuoteCarry({ market, side, leverage, holdingMs }) {
  if (!["long", "short"].includes(side)) throw new TypeError("gmx-side-required");
  if (!(Number.isFinite(leverage) && leverage > 0)) throw new RangeError("gmx-leverage-required");
  if (!(Number.isFinite(holdingMs) && holdingMs > 0)) throw new RangeError("gmx-holding-period-required");
  const carry = gmxMarketCarry(market);
  const fraction = carry.annualCost[side] * leverage * (holdingMs / YEAR_MS);
  return Object.freeze({ side, leverage, holdingMs, annualCost: carry.annualCost[side], carryCostFraction: Math.max(0, fraction), fundingCreditFraction: Math.max(0, -fraction), carry });
}

