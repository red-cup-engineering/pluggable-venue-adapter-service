import assert from "node:assert/strict";
import test from "node:test";
import { gmxMarketCarry, gmxQuoteCarry } from "../src/gmx-adapter.mjs";

// Two rows of GMX's public /markets/info (Arbitrum), as the emsenn-trading collectors recorded them.
const BTC = { name: "BTC/USD [WBTC.b-USDC]", fundingRateLong: "-64629868024946995720577368360", fundingRateShort: "69033871259900146647147168000",
  borrowingRateLong: "70963284825776905012865808000", borrowingRateShort: "0", netRateLong: "6333416800829909292288439640", netRateShort: "69033871259900146647147168000" };
const ETH = { name: "ETH/USD [ETH-USDC]", fundingRateLong: "-82327713628559595385935706750", fundingRateShort: "83258635089739807445141232000",
  borrowingRateLong: "34556810726430323752543200000", borrowingRateShort: "0", netRateLong: "-47770902902129271633392506750", netRateShort: "83258635089739807445141232000" };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("rates are annual fractions in 30-decimal fixed point; a side's cost is borrowing less the funding it receives", () => {
  const btc = gmxMarketCarry(BTC);
  assert.ok(near(btc.funding.long, -0.064629868024)); assert.ok(near(btc.borrowing.long, 0.070963284825));
  // longs pay 6.46% funding and 7.10% borrowing a year; shorts receive 6.90% and borrow nothing
  assert.ok(near(btc.annualCost.long, 0.070963284825 + 0.064629868024)); assert.ok(near(btc.annualCost.short, -0.069033871259));
  const eth = gmxMarketCarry(ETH);
  assert.ok(near(eth.annualCost.long, 0.034556810726 + 0.082327713628)); assert.ok(eth.annualCost.short < 0);
});

test("the reported netRate is recorded but is no side's cost: it equals funding + borrowing in both markets", () => {
  for (const row of [BTC, ETH]) {
    const c = gmxMarketCarry(row);
    assert.ok(near(c.netRateReported.long, c.funding.long + c.borrowing.long, 1e-11));
    assert.ok(!near(c.netRateReported.long, c.annualCost.long, 1e-3));
  }
});

test("a quote's carry is the cost over the holding period at its leverage, as a fraction of collateral", () => {
  const month = 30 * 86_400_000;
  const long = gmxQuoteCarry({ market: BTC, side: "long", leverage: 2, holdingMs: month });
  assert.ok(near(long.carryCostFraction, gmxMarketCarry(BTC).annualCost.long * 2 * 30 / 365)); assert.equal(long.fundingCreditFraction, 0);
  // a short earning funding carries no cost; the credit is its own field, for the scenario payoff
  const short = gmxQuoteCarry({ market: BTC, side: "short", leverage: 3, holdingMs: 73 * 86_400_000 });
  assert.equal(short.carryCostFraction, 0); assert.ok(near(short.fundingCreditFraction, 0.069033871259 * 3 * 0.2, 1e-9));
});

test("missing rates, negative borrowing and bad inputs refuse", () => {
  assert.throws(() => gmxMarketCarry({ ...BTC, fundingRateShort: undefined }), /gmx-funding-rate-short-required/);
  assert.throws(() => gmxMarketCarry({ ...BTC, borrowingRateLong: "-1" + "0".repeat(28) }), /gmx-borrowing-rate-negative/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "up", leverage: 2, holdingMs: 1 }), /gmx-side-required/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "long", leverage: 0, holdingMs: 1 }), /gmx-leverage-required/);
  assert.throws(() => gmxQuoteCarry({ market: BTC, side: "long", leverage: 2, holdingMs: 0 }), /gmx-holding-period-required/);
});
