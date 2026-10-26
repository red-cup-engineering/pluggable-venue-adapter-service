import assert from "node:assert/strict";
import test from "node:test";
import { gmxMarketCarry, gmxQuoteCarry } from "../src/gmx-adapter.mjs";

// Synthetic fixtures for this owner's legacy Oracle contract: annual E30 rates,
// positive funding is a cost, and negative funding is received by that side.
// Raw strings are retained from the original test. Their claimed historical
// collection has no separately retained timestamp/response here; these tests
// do not validate current API data or the SDK's different sign/period convention.
const BTC = { name: "BTC/USD [WBTC.b-USDC]", fundingRateLong: "-64629868024946995720577368360", fundingRateShort: "69033871259900146647147168000",
  borrowingRateLong: "70963284825776905012865808000", borrowingRateShort: "0", netRateLong: "6333416800829909292288439640", netRateShort: "69033871259900146647147168000" };
const ETH = { name: "ETH/USD [ETH-USDC]", fundingRateLong: "-82327713628559595385935706750", fundingRateShort: "83258635089739807445141232000",
  borrowingRateLong: "34556810726430323752543200000", borrowingRateShort: "0", netRateLong: "-47770902902129271633392506750", netRateShort: "83258635089739807445141232000" };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("legacy Oracle contract uses annual E30 rates with positive funding as cost", () => {
  const btc = gmxMarketCarry(BTC);
  assert.ok(near(btc.funding.long, -0.064629868024)); assert.ok(near(btc.borrowing.long, 0.070963284825));
  // 0.070963284825 borrowing minus 0.064629868024 received funding.
  assert.ok(near(btc.annualCost.long, 0.006333416801));
  assert.ok(near(btc.annualCost.short, 0.069033871259));
  const eth = gmxMarketCarry(ETH);
  // Received funding exceeds borrowing for this synthetic ETH long side.
  assert.ok(near(eth.annualCost.long, -0.047770902902));
  assert.ok(near(eth.annualCost.short, 0.083258635089));
});

test("legacy Oracle net rates retain the signed annual cost for both sides", () => {
  for (const [row, expected] of [
    [BTC, { long: 0.006333416800829909292288439640, short: 0.069033871259900146647147168000 }],
    [ETH, { long: -0.047770902902129271633392506750, short: 0.083258635089739807445141232000 }],
  ]) {
    const c = gmxMarketCarry(row);
    for (const side of ['long', 'short']) {
      assert.ok(near(c.netRateReported[side], expected[side], 1e-11));
      assert.ok(near(c.annualCost[side], expected[side], 1e-11));
    }
  }
});

test("a quote's carry is the cost over the holding period at its leverage, as a fraction of collateral", () => {
  const month = 30 * 86_400_000;
  const long = gmxQuoteCarry({ market: BTC, side: "long", leverage: 2, holdingMs: month });
  // 0.006333416801 annual cost * 2 leverage * 30/365 years.
  assert.ok(near(long.carryCostFraction, 0.001041109611123287)); assert.equal(long.fundingCreditFraction, 0);
  const short = gmxQuoteCarry({ market: BTC, side: "short", leverage: 3, holdingMs: 73 * 86_400_000 });
  // 0.069033871259 annual cost * 3 leverage * 73/365 years.
  assert.ok(near(short.carryCostFraction, 0.0414203227554)); assert.equal(short.fundingCreditFraction, 0);
  // A negative net cost is a separate credit, never a negative carry cost.
  const credit = gmxQuoteCarry({ market: ETH, side: "long", leverage: 3, holdingMs: 73 * 86_400_000 });
  assert.equal(credit.carryCostFraction, 0); assert.ok(near(credit.fundingCreditFraction, 0.0286625417412));
});

test("missing rates, negative borrowing and bad inputs refuse", () => {
  assert.throws(() => gmxMarketCarry({ ...BTC, fundingRateShort: undefined }), /gmx-funding-rate-short-required/);
  assert.throws(() => gmxMarketCarry({ ...BTC, borrowingRateLong: "-1" + "0".repeat(28) }), /gmx-borrowing-rate-negative/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "up", leverage: 2, holdingMs: 1 }), /gmx-side-required/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "long", leverage: 0, holdingMs: 1 }), /gmx-leverage-required/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "long", leverage: 2, holdingMs: 0 }), /gmx-holding-period-required/);
});
