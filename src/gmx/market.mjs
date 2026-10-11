import { gmxMarketCarry } from "./model.mjs";
import { GMX_CHAINS } from "../../data/gmx/contracts.mjs";
export const VENUE = "gmx";
export const DEFAULT_BASE_URL = GMX_CHAINS[42161].api;
export const MARKET_NAME = Object.freeze({ BTC: "BTC/USD [WBTC.b-USDC]", ETH: "ETH/USD [ETH-USDC]" });
/**
 * GMX v2's own fixed-point convention (see docs.gmx.io "Contracts" /
 * `Precision.sol` in the gmx-synthetics contracts): most quantities are
 * emitted as integers scaled by `10^30` ("float precision"); USD-denominated
 * quantities additionally correct for the underlying token's own decimals,
 * so a *price* is `rawPrice / 10^(30 - tokenDecimals)` while a quantity
 * GMX's own API already expresses directly in USD (open interest, available
 * liquidity) is `rawUsd / 10^30`.
 *
 * `raw` values arrive from the API as decimal strings with up to ~40 digits
 * -- well past `Number.MAX_SAFE_INTEGER` (2^53). Converting through `Number`
 * before dividing keeps the full ~15-17 significant decimal digits a double
 * carries, which is far more precision than a market price needs; what it
 * cannot do is round-trip the exact integer. That trade is fine here (this
 * is a price/USD reader, not an accounting ledger) and is why `rawFloat` is
 * documented as an approximation rather than treated as exact.
 */

const FLOAT_PRECISION_EXP = 30;

/** `rawUsd / 10^30`, GMX's own float-precision USD convention. */
export function usdFromRaw30(raw) {
  if (raw === null || raw === undefined) return null;
  return Number(raw) / 10 ** FLOAT_PRECISION_EXP;
}

/** `rawPrice / 10^(30 - decimals)`, GMX's own oracle-price convention. */
export function priceFromRaw(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  return Number(raw) / 10 ** (FLOAT_PRECISION_EXP - decimals);
}

/** Pure: `raw` -> an array of normalized snapshot entries (see `../../SCHEMAS.md`). */
export function normalize(raw) {
  const { fetchedAt, coins, marketsInfo, tickers, tokens } = raw;
  const tokenByAddress = new Map(tokens.tokens.map((t) => [t.address.toLowerCase(), t]));
  const tickerByAddress = new Map(tickers.map((t) => [t.tokenAddress.toLowerCase(), t]));
  const entries = [];

  for (const coin of coins) {
    const marketName = MARKET_NAME[coin];
    const market = marketName && marketsInfo.markets.find((m) => m.name === marketName);
    if (!market) {
      entries.push({
        venue: VENUE,
        market: `${coin}-USD`,
        venueMarketId: marketName ?? coin,
        collectedAt: fetchedAt,
        error: marketName
          ? `GMX market '${marketName}' not found in /markets/info at fetch time.`
          : `No GMX MARKET_NAME mapping for '${coin}'.`,
      });
      continue;
    }

    const indexToken = tokenByAddress.get(market.indexToken.toLowerCase());
    const indexTicker = tickerByAddress.get(market.indexToken.toLowerCase());
    const midUsd = indexTicker && indexToken
      ? (priceFromRaw(indexTicker.minPrice, indexToken.decimals) + priceFromRaw(indexTicker.maxPrice, indexToken.decimals)) / 2
      : null;

    const oiLongUsd = usdFromRaw30(market.openInterestLong);
    const oiShortUsd = usdFromRaw30(market.openInterestShort);
    const availLongUsd = usdFromRaw30(market.availableLiquidityLong);
    const availShortUsd = usdFromRaw30(market.availableLiquidityShort);

    const carry = gmxMarketCarry(market);
    entries.push({
      venue: VENUE,
      market: `${coin}-USD`,
      venueMarketId: market.name,
      observedAt: indexTicker?.updatedAt ? new Date(indexTicker.updatedAt).toISOString() : fetchedAt,
      collectedAt: fetchedAt,
      mid: {
        available: midUsd !== null,
        usd: midUsd,
        raw: { minPrice: indexTicker?.minPrice, maxPrice: indexTicker?.maxPrice, decimals: indexToken?.decimals, indexToken: market.indexToken },
        notes: `Midpoint of GMX's own min/max oracle price for the index token, converted with GMX's price = rawPrice / 10^(30 - decimals) convention (decimals from /tokens).`,
      },
      funding: {
        available: true,
        rate: carry.funding.long / 8760,
        intervalHours: 1,
        unit: 'fraction',
        confidence: 'measured',
        annualRateBySide: carry.funding,
        annualBorrowingBySide: carry.borrowing,
        annualCostBySide: carry.annualCost,
        raw: {
          fundingRateLong: market.fundingRateLong,
          fundingRateShort: market.fundingRateShort,
          borrowingRateLong: market.borrowingRateLong,
          borrowingRateShort: market.borrowingRateShort,
        },
        notes: "Legacy Oracle REST rates are annualized E30 fractions; positive means that side pays. rate is the long-side annual fraction divided by 8760 for an hourly comparison. Side-specific annual funding, borrowing and total costs are retained; SDK funding signs differ. A current rate is a snapshot, not a realized yield.",
      },
      openInterest: {
        available: oiLongUsd !== null && oiShortUsd !== null,
        baseUnits: null,
        usd: oiLongUsd !== null && oiShortUsd !== null ? oiLongUsd + oiShortUsd : null,
        long: oiLongUsd !== null ? { usd: oiLongUsd } : null,
        short: oiShortUsd !== null ? { usd: oiShortUsd } : null,
        raw: { openInterestLong: market.openInterestLong, openInterestShort: market.openInterestShort },
        notes: 'GMX reports open interest directly in USD (float precision, /1e30), split long/short -- unlike Hyperliquid, no base-units conversion is needed or available.',
      },
      signedTradeFlow: {
        available: false,
        notes: "No public recent-trades endpoint was reachable on GMX's arbitrum-api.gmxinfra.io during this package's venue survey (2026-08-21): /trades, /trades?marketAddress=..., and the legacy thegraph.com GMX subgraph all 404'd or redirected without responding. A per-trade tape would require indexing GMX's on-chain events directly, out of scope for a public-REST-only collector.",
      },
      depthSummary: {
        available: availLongUsd !== null && availShortUsd !== null,
        kind: 'amm-available-liquidity',
        availableLiquidityLongUsd: availLongUsd,
        availableLiquidityShortUsd: availShortUsd,
        raw: { availableLiquidityLong: market.availableLiquidityLong, availableLiquidityShort: market.availableLiquidityShort },
        notes: "GMX has no order book to snapshot (it's AMM-style, priced by oracle against a shared pool); this is GMX's own reported remaining capacity (USD) for new long/short open interest before the pool's caps bind -- the venue's real analog to depth, not a bid/ask ladder.",
      },
      liquidations: {
        available: false,
        notes: 'No public liquidations endpoint was reachable on the same GMX API surface during this venue survey.',
      },
      sourceEndpoints: [
        { url: `${raw.sourceBaseUrl ?? DEFAULT_BASE_URL}/markets/info`, method: 'GET' },
        { url: `${raw.sourceBaseUrl ?? DEFAULT_BASE_URL}/prices/tickers`, method: 'GET' },
        { url: `${raw.sourceBaseUrl ?? DEFAULT_BASE_URL}/tokens`, method: 'GET' },
      ],
    });
  }
  return entries;
}
