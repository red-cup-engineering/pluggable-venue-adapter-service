import assert from "node:assert/strict";
import test from "node:test";
import { createKalshiAdapter, normalizeKalshiAccount } from "../src/kalshi-adapter.mjs";

const now = "2026-10-03T12:00:00Z";
const contract = { type: "PrincipalBrokerageServiceContract", id: "urn:contract:kalshi-fixture", capital: { amount: 100, currency: "USD" }, risk: { maximumLossAmount: 100, maximumOrderNotional: 50, maximumAggregateNotional: 100, concentrationLimit: 1 } };
const grant = { type: "RevocableBrokerageAuthorityGrant", id: "urn:grant:kalshi-fixture", principalContract: contract.id, adapter: "kalshi", validUntil: "2027-01-01T00:00:00Z", scopes: ["account:read", "positions:read", "orders:read", "orders:live"], credentialReference: "~/.config/561-group/kalshi.env" };

function fakeClient(overrides = {}) {
  const calls = [];
  const record = (name, result) => (...args) => { calls.push([name, ...args]); return typeof result === "function" ? result(...args) : Promise.resolve(result); };
  const client = {
    getBalance: record("getBalance", { balance: 2500, portfolio_value: 300 }),
    getPositions: record("getPositions", { market_positions: [{ ticker: "KXHIGHNY-26OCT04-T50", position_fp: "-4.00", market_exposure_dollars: "3.8800" }] }),
    getOrders: record("getOrders", [{ order_id: "o1", ticker: "KXHIGHNY-26OCT04-T51", book_side: "ask", yes_price_dollars: "0.0400", remaining_count_fp: "10.00", expiration_time: "2026-10-03T13:00:00Z" }]),
    getFills: record("getFills", [{ order_id: "o9", ticker: "KXHIGHNY-26OCT04-T51", count_fp: "2.00", created_time: "2026-10-03T12:30:00Z" }]),
    createOrder: record("createOrder", { order_id: "o2", fill_count: "0.00" }),
    cancelOrder: record("cancelOrder", {}),
    ...overrides,
  };
  return { client, calls };
}

test("normalizeKalshiAccount: equity is balance plus portfolio, free cash excludes resting sell collateral", () => {
  const account = normalizeKalshiAccount({
    balance: { balance: 2500, portfolio_value: 300 },
    positions: { market_positions: [{ ticker: "KXHIGHNY-26OCT04-T50", position_fp: "-4.00", market_exposure_dollars: "3.8800" }, { ticker: "FLAT-1-A", position_fp: "0.00", market_exposure_dollars: "0" }] },
    orders: [
      { order_id: "a", ticker: "KXHIGHNY-26OCT04-T51", book_side: "ask", yes_price_dollars: "0.0400", remaining_count_fp: "10.00" },
      { order_id: "b", ticker: "KXHIGHNY-26OCT04-T49", side: "yes", action: "buy", yes_price_dollars: "0.5000", remaining_count_fp: "3.00" },
      { order_id: "c", ticker: "KXLOWCHI-26OCT05-T40", side: "no", action: "buy", yes_price_dollars: "0.0300", remaining_count_fp: "2.00" },
    ],
  });
  assert.equal(account.cashCents, 2500);
  assert.equal(account.equityCents, 2800);
  assert.equal(account.restingCollateralCents, 96 * 10 + 97 * 2);
  assert.equal(account.freeCashCents, 2500 - 960 - 194);
  assert.deepEqual(account.positions, [{ ticker: "KXHIGHNY-26OCT04-T50", eventTicker: "KXHIGHNY-26OCT04", side: "no", contracts: 4, costCents: 388 }]);
  assert.deepEqual(account.resting.map((order) => [order.orderId, order.bookSide, order.priceCents, order.count]), [["a", "ask", 4, 10], ["b", "bid", 50, 3], ["c", "ask", 3, 2]]);
  assert.throws(() => normalizeKalshiAccount({ balance: {} }), /kalshi-balance-required/);
});

test("reads return frozen identified receipts and call the client once", async () => {
  const { client, calls } = fakeClient();
  const adapter = createKalshiAdapter({ client });
  const account = await adapter.readAccount({ grant, now });
  const positions = await adapter.listPositions({ grant, now });
  const resting = await adapter.listRestingOrders({ grant, now });
  for (const receipt of [account, positions, resting]) {
    assert.equal(receipt.type, "KalshiVenueOperationReceipt");
    assert.equal(receipt.outcome, "accepted");
    assert.equal(receipt.credentialsExported, false);
    assert.equal(receipt.grant, grant.id);
    assert.ok(Object.isFrozen(receipt));
    assert.match(receipt.id, /\S/);
  }
  assert.deepEqual(account.payload, { balance: 2500, portfolio_value: 300 });
  assert.equal(resting.payload.orders.length, 1);
  assert.deepEqual(calls.map(([name]) => name), ["getBalance", "getPositions", "getOrders"]);
  assert.deepEqual(calls[2][1], { status: "resting" });
  // The receipts fold straight back into the normalized account.
  const normalized = normalizeKalshiAccount({ balance: account.payload, positions: positions.payload, orders: resting.payload.orders });
  assert.equal(normalized.equityCents, 2800);
});

test("receipt identity is stable across payload key order and changes with content", async () => {
  const one = createKalshiAdapter({ client: fakeClient({ getBalance: async () => ({ balance: 5, portfolio_value: 1 }) }).client });
  const two = createKalshiAdapter({ client: fakeClient({ getBalance: async () => ({ portfolio_value: 1, balance: 5 }) }).client });
  const three = createKalshiAdapter({ client: fakeClient({ getBalance: async () => ({ balance: 6, portfolio_value: 1 }) }).client });
  assert.equal((await one.readAccount({ grant, now })).id, (await two.readAccount({ grant, now })).id);
  assert.notEqual((await one.readAccount({ grant, now })).id, (await three.readAccount({ grant, now })).id);
});

test("placeOrder and cancelOrder pass the order through under orders:live", async () => {
  const { client, calls } = fakeClient();
  const adapter = createKalshiAdapter({ client });
  const placed = await adapter.placeOrder({ grant, contract, now, order: { ticker: "KXHIGHNY-26OCT04-T51", side: "ask", count: 12, price: 0.03, postOnly: true, expirationTime: 1790000000, clientOrderId: "wd-abc" } });
  assert.equal(placed.scope, "orders:live");
  assert.equal(placed.method, "POST");
  assert.deepEqual(placed.payload, { order_id: "o2", fill_count: "0.00" });
  assert.deepEqual(calls.find((call) => call[0] === "createOrder"), ["createOrder", { ticker: "KXHIGHNY-26OCT04-T51", side: "ask", count: 12, price: 0.03, postOnly: true, expirationTime: 1790000000, clientOrderId: "wd-abc" }]);
  const cancelled = await adapter.cancelOrder({ grant, now, orderId: "o2", ticker: "KXHIGHNY-26OCT04-T51" });
  assert.equal(cancelled.method, "DELETE");
  assert.deepEqual(calls.at(-1), ["cancelOrder", "o2", "KXHIGHNY-26OCT04-T51"]);
});

test("a grant without the scope, expired, revoked, or of another venue refuses before the client is called", async () => {
  const { client, calls } = fakeClient();
  const adapter = createKalshiAdapter({ client });
  const order = { ticker: "T-1", side: "ask", count: 1, price: 0.03, clientOrderId: "c-1" };
  await assert.rejects(adapter.placeOrder({ grant: { ...grant, scopes: ["account:read"] }, order, now }), /venue-operation-scope-refused/);
  await assert.rejects(adapter.readAccount({ grant: { ...grant, validUntil: now }, now }), /authority-expired/);
  await assert.rejects(adapter.readAccount({ grant: { ...grant, revoked: true }, now }), /current-authority-grant-required/);
  await assert.rejects(adapter.readAccount({ grant: { ...grant, adapter: "alpaca-trading-live" }, now }), /kalshi-authority-required/);
  await assert.rejects(adapter.readAccount({ grant: { ...grant, type: "Other" }, now }), /current-authority-grant-required/);
  await assert.rejects(adapter.readAccount({ grant, now: "not a time" }), /authority-time-invalid/);
  assert.equal(calls.length, 0);
});

test("credential-bearing requests are refused and credential-like response fields are dropped", async () => {
  const { client, calls } = fakeClient({ getBalance: async () => ({ balance: 1, portfolio_value: 0, api_secret: "x", nested: { private_key: "y", fine: 1 } }) });
  const adapter = createKalshiAdapter({ client });
  await assert.rejects(adapter.placeOrder({ grant, now, order: { ticker: "T-1", side: "ask", count: 1, price: 0.03, apiKey: "nope" } }), /credential-bearing-venue-request-refused/);
  assert.equal(calls.length, 0);
  const receipt = await adapter.readAccount({ grant, now });
  assert.deepEqual(receipt.payload, { balance: 1, portfolio_value: 0, nested: { fine: 1 } });
});

test("a venue refusal becomes a receipt; a write whose outcome is unknown says so", async () => {
  const refused = Object.assign(new Error("http-400"), { code: "http-400", detail: "post only cross", status: 400, venueWrite: false });
  const lost = Object.assign(new Error("network"), { code: "network", detail: "timeout", status: null, venueWrite: true });
  const order = { ticker: "T-1", side: "ask", count: 1, price: 0.03, clientOrderId: "c-1" };
  const a = await createKalshiAdapter({ client: fakeClient({ createOrder: async () => { throw refused; } }).client }).placeOrder({ grant, contract, order, now });
  assert.equal(a.outcome, "refused"); assert.equal(a.status, 400); assert.equal(a.error.code, "http-400");
  const b = await createKalshiAdapter({ client: fakeClient({ createOrder: async () => { throw lost; } }).client }).placeOrder({ grant, contract, order, now });
  assert.equal(b.outcome, "indeterminate"); assert.equal(b.error.venueWrite, true);
  await assert.rejects(createKalshiAdapter({ client: fakeClient({ getBalance: async () => { throw new TypeError("bug"); } }).client }).readAccount({ grant, now }), /bug/);
});

test("malformed orders and clients are refused", async () => {
  assert.throws(() => createKalshiAdapter({}), /kalshi-adapter-configuration-invalid/);
  const adapter = createKalshiAdapter({ client: fakeClient().client });
  await assert.rejects(adapter.placeOrder({ grant, contract, now, order: { ticker: "T-1", side: "yes", count: 1, price: 0.03, clientOrderId: "c" } }), /kalshi-order-side-invalid/);
  await assert.rejects(adapter.placeOrder({ grant, contract, now, order: { ticker: "T-1", side: "ask", count: 1, price: 3, clientOrderId: "c" } }), /kalshi-order-count-or-price-invalid/);
  await assert.rejects(adapter.placeOrder({ grant, contract, now, order: { ticker: "T-1", side: "ask", count: 1, price: 0.03 } }), /kalshi-client-order-id-required/);
  await assert.rejects(adapter.placeOrder({ grant, contract: { ...contract, id: "urn:contract:other" }, now, order: { ticker: "T-1", side: "ask", count: 1, price: 0.03, clientOrderId: "c" } }), /grant-names-another-contract/);
  assert.throws(() => adapter.cancelOrder({ grant, now, orderId: "", ticker: "T-1" }), /order-id-required/);
});

test("the principal contract refuses an order before the venue sees it, and preflight never writes", async () => {
  const tight = { ...contract, risk: { ...contract.risk, maximumOrderNotional: 0.5 } };
  const { client, calls } = fakeClient();
  const adapter = createKalshiAdapter({ client });
  const order = { ticker: "KXHIGHNY-26OCT05-T80", side: "ask", count: 1, price: 0.03, clientOrderId: "c-2" };
  const refused = await adapter.placeOrder({ grant, contract: tight, order, now });
  assert.equal(refused.outcome, "refused-by-contract");
  assert.match(refused.error.detail, /order risk 97c above the contract's 50c/u);
  const preflight = await adapter.preflightOrder({ grant, contract, order, now });
  assert.equal(preflight.verdict.ok, true);
  assert.equal(calls.some((call) => call[0] === "createOrder"), false, "neither the refusal nor the preflight wrote");
});

test("at the loss boundary no new risk is admitted", async () => {
  const lost = { ...contract, capital: { amount: 40, currency: "USD" }, risk: { ...contract.risk, maximumLossAmount: 10 } };
  const adapter = createKalshiAdapter({ client: fakeClient().client });
  const verdict = (await adapter.preflightOrder({ grant, contract: lost, now, order: { ticker: "KXHIGHNY-26OCT05-T80", side: "ask", count: 1, price: 0.03, clientOrderId: "c-3" } })).verdict;
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /loss boundary/u);
});

test("fills come with a reconciliation cursor", async () => {
  const receipt = await createKalshiAdapter({ client: fakeClient().client }).listFills({ grant, sinceTs: 0, now });
  assert.equal(receipt.payload.fills.length, 1);
  assert.equal(receipt.payload.cursor, Math.floor(Date.parse("2026-10-03T12:30:00Z") / 1000));
});
