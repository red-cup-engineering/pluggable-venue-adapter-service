/**
 * The Kalshi venue adapter on the venue authority chain.
 *
 * Same discipline as alpaca-adapter.mjs: every operation is admitted against a
 * `RevocableBrokerageAuthorityGrant` (current, unrevoked, unexpired, carrying the
 * operation's scope), requests that carry credential fields are refused, response
 * fields that look like credentials are dropped, and every operation returns a
 * frozen, content-identified receipt.
 *
 * What differs is custody. Kalshi signs each request itself, so the adapter is
 * handed a ready `createKalshiClient` instance (kalshi-services-section
 * src/client.mjs) by whoever holds the credential; the adapter reads no
 * environment and no key path, and the grant names the custody path only by
 * reference. Scopes: account:read, positions:read, orders:read, orders:live.
 *
 * A write is admitted twice: by the grant (scope, expiry, revocation) and by the
 * principal's contract the grant names, against an account reading taken
 * immediately before it. A binary contract's notional is its risk: the price of
 * the side bought (YES at its price, NO at 100 less the YES price). The contract
 * bounds one order's risk, the account's open risk, one event's share of capital,
 * and the loss below capital at which no new risk is admitted. preflightOrder runs
 * the same admission without writing. Every write carries the caller's client
 * order id, so a venue that sees it twice places once.
 */
import { semanticIdOf } from "@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity";

const semanticId = semanticIdOf("brokerage.pluggable-venue-adapter.record");
const identify = (body) => ({ id: semanticId(body), ...body });
const CREDENTIAL_FIELDS = new Set(["authorization", "apikey", "apikeyid", "apisecret", "clientid", "clientsecret", "secret", "token", "accesstoken", "refreshtoken", "privatekey", "privatekeypath", "password"]);
const credentialField = (key) => { const normalized = String(key).toLowerCase().replace(/[-_\s]/gu, ""); return [...CREDENTIAL_FIELDS, "apisecretkey"].some((suffix) => normalized === suffix || normalized.endsWith(suffix)); };
function rejectCredentials(value, seen = new Set()) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); for (const [key, member] of Object.entries(value)) { if (credentialField(key)) throw new TypeError("credential-bearing-venue-request-refused"); rejectCredentials(member, seen); } }
function admit(grant, scope, operation, now) { rejectCredentials(operation); const at = Date.parse(now), expiry = Date.parse(grant?.validUntil); if (!Number.isFinite(at) || !Number.isFinite(expiry)) throw new TypeError("authority-time-invalid"); if (grant?.type !== "RevocableBrokerageAuthorityGrant" || grant.revoked === true) throw new TypeError("current-authority-grant-required"); if (grant.adapter !== "kalshi") throw new TypeError("kalshi-authority-required"); if (at >= expiry) throw new TypeError("authority-expired"); if (!grant.scopes?.includes(scope)) throw new TypeError("venue-operation-scope-refused"); return grant; }
function clean(value, seen = new Set()) { if (!value || typeof value !== "object") return value; if (seen.has(value)) return null; seen.add(value); if (Array.isArray(value)) return value.map((member) => clean(member, seen)); return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialField(key)).map(([key, member]) => [key, clean(member, seen)])); }

const cents = (dollars) => Math.round(Number(dollars) * 100);
const riskOf = ({ side, count, price }) => Math.ceil(Number(count) * (side === "ask" ? 100 - Number(price) * 100 : Number(price) * 100) - 1e-9);
const restingRisk = (order) => Math.ceil(order.count * (order.bookSide === "ask" ? 100 - order.priceCents : order.priceCents) - 1e-9);

/**
 * The principal contract's verdict on one order, against an account reading. Pure.
 * @returns {{ok: true, orderRiskCents: number, openRiskCents: number, eventRiskCents: number} | {ok: false, reason: string}}
 */
export function admitKalshiOrderUnderContract({ contract, account, order }) {
  if (contract?.type !== "PrincipalBrokerageServiceContract") return { ok: false, reason: "principal-contract-required" };
  const capitalCents = cents(contract.capital.amount), risk = contract.risk;
  const orderRiskCents = riskOf(order);
  const eventTicker = order.ticker.slice(0, order.ticker.lastIndexOf("-"));
  const openRiskCents = account.positions.reduce((sum, row) => sum + row.costCents, 0) + account.resting.reduce((sum, row) => sum + restingRisk(row), 0);
  const eventRiskCents = account.positions.filter((row) => row.eventTicker === eventTicker).reduce((sum, row) => sum + row.costCents, 0)
    + account.resting.filter((row) => row.eventTicker === eventTicker).reduce((sum, row) => sum + restingRisk(row), 0);
  if (capitalCents - account.equityCents >= cents(risk.maximumLossAmount)) return { ok: false, reason: `loss boundary reached: equity ${account.equityCents}c against capital ${capitalCents}c and maximum loss ${cents(risk.maximumLossAmount)}c` };
  if (orderRiskCents > cents(risk.maximumOrderNotional)) return { ok: false, reason: `order risk ${orderRiskCents}c above the contract's ${cents(risk.maximumOrderNotional)}c` };
  if (openRiskCents + orderRiskCents > cents(risk.maximumAggregateNotional)) return { ok: false, reason: `open risk ${openRiskCents + orderRiskCents}c above the contract's ${cents(risk.maximumAggregateNotional)}c` };
  if (eventRiskCents + orderRiskCents > Math.floor(risk.concentrationLimit * capitalCents)) return { ok: false, reason: `event ${eventTicker} risk ${eventRiskCents + orderRiskCents}c above the contract's ${risk.concentrationLimit} of capital` };
  if (orderRiskCents > account.freeCashCents) return { ok: false, reason: `order risk ${orderRiskCents}c above free cash ${account.freeCashCents}c` };
  return { ok: true, orderRiskCents, openRiskCents, eventRiskCents };
}
const eventOf = (ticker) => ticker.slice(0, ticker.lastIndexOf("-"));

/**
 * The account as one venue-neutral reading, from Kalshi's own three payloads.
 * Kalshi's balance does NOT set aside a resting order's collateral, so equity is
 * balance plus portfolio value and only cash beyond the collateral of resting
 * YES sells (each risks 100 - yes price per contract) is free.
 * @param {{balance: {balance: number, portfolio_value: number}, positions: object[]|{market_positions?: object[]}, orders: object[]|{orders?: object[]}}} reading
 * @returns {{cashCents: number, equityCents: number, freeCashCents: number, restingCollateralCents: number,
 *   positions: {ticker: string, eventTicker: string, side: "yes"|"no", contracts: number, costCents: number}[],
 *   resting: {orderId: string, ticker: string, eventTicker: string, bookSide: "bid"|"ask", priceCents: number, count: number, expiration: string|null}[]}}
 */
export function normalizeKalshiAccount({ balance, positions = [], orders = [] } = {}) {
  if (!Number.isInteger(balance?.balance)) throw new TypeError("kalshi-balance-required");
  const marketPositions = Array.isArray(positions) ? positions : positions.market_positions ?? [];
  const restingOrders = Array.isArray(orders) ? orders : orders.orders ?? [];
  const held = marketPositions
    .filter((row) => Number(row.position_fp) !== 0)
    .map((row) => { const signed = Number(row.position_fp); return { ticker: row.ticker, eventTicker: eventOf(row.ticker), side: signed < 0 ? "no" : "yes", contracts: Math.abs(signed), costCents: cents(row.market_exposure_dollars) }; });
  const resting = restingOrders.map((order) => ({
    orderId: order.order_id, ticker: order.ticker, eventTicker: eventOf(order.ticker),
    bookSide: order.book_side ?? ((order.side === "yes" && order.action === "sell") || (order.side === "no" && order.action === "buy") ? "ask" : "bid"),
    priceCents: Number(order.yes_price_dollars) * 100, count: Number(order.remaining_count_fp), expiration: order.expiration_time ?? null,
  }));
  if (held.some(row=>!Number.isFinite(row.contracts)||row.contracts<=0||!Number.isFinite(row.costCents)||row.costCents<0)) throw new TypeError('kalshi-position-value-invalid');
  if (resting.some((order) => !['bid','ask'].includes(order.bookSide) || !Number.isFinite(order.priceCents) || order.priceCents < 0 || order.priceCents > 100 || !Number.isFinite(order.count) || order.count < 0)) throw new TypeError('kalshi-resting-order-value-invalid');
  const restingCollateralCents = resting.reduce((sum, order) => sum + Math.ceil((order.bookSide === 'ask' ? 100 - order.priceCents : order.priceCents) * order.count - 1e-9), 0);
  const cashCents = balance.balance, portfolioCents = Number.isInteger(balance.portfolio_value) ? balance.portfolio_value : 0;
  return { cashCents, equityCents: cashCents + portfolioCents, freeCashCents: cashCents - restingCollateralCents, restingCollateralCents, positions: held, resting };
}

/**
 * @param {{client: {getBalance: Function, getPositions: Function, getOrders: Function, createOrder: Function, cancelOrder: Function}}} options
 *   client: a createKalshiClient instance, already bound to its credential by the custodian.
 */
export function createKalshiAdapter({ client } = {}) {
  for (const method of ["getBalance", "getPositions", "getOrders", "getFills", "createOrder", "cancelOrder"]) if (typeof client?.[method] !== "function") throw new TypeError("kalshi-adapter-configuration-invalid");
  const observe = async () => normalizeKalshiAccount({ balance: await client.getBalance(), positions: await client.getPositions({ count_filter: "position" }), orders: await client.getOrders({ status: "resting" }) });
  const checkOrder = (order) => {
    if (!order || (order.side !== "bid" && order.side !== "ask")) throw new TypeError("kalshi-order-side-invalid");
    if (typeof order.ticker !== "string" || order.ticker.length === 0) throw new TypeError("kalshi-order-ticker-required");
    if (!(Number(order.count) >= 0.01) || !(Number(order.price) > 0 && Number(order.price) < 1)) throw new TypeError("kalshi-order-count-or-price-invalid");
    if (typeof order.clientOrderId !== "string" || order.clientOrderId.length === 0) throw new TypeError("kalshi-client-order-id-required");
  };
  const contractOf = (grant, contract) => { if (contract?.id !== grant?.principalContract) throw new TypeError("grant-names-another-contract"); return contract; };
  // The contract's verdict, from an account reading taken now; refused orders never reach the venue.
  const admitUnderContract = async ({ grant, contract, order, now }) => {
    admit(grant, "orders:live", { order }, now);
    checkOrder(order);
    return admitKalshiOrderUnderContract({ contract: contractOf(grant, contract), account: await observe(), order });
  };
  const call = async ({ grant, scope, method, path, run, now = new Date().toISOString(), operation = {} }) => {
    admit(grant, scope, { method, path, ...operation }, now);
    let outcome = "accepted", status = 200, payload, error = null;
    try {
      payload = await run();
    } catch (failure) {
      // A venue refusal is a fact the receipt records; anything else (programming errors) is not.
      if (typeof failure?.code !== "string") throw failure;
      status = failure.status ?? null;
      outcome = failure.venueWrite === true ? "indeterminate" : "refused";
      error = { code: failure.code, detail: failure.detail ?? failure.message, venueWrite: failure.venueWrite === true };
    }
    return Object.freeze(identify({ type: "KalshiVenueOperationReceipt", version: 1, venue: "kalshi", grant: grant.id, scope, method, path, outcome, status, observedAt: now,
      payload: clean(payload) ?? null, error, credentialReference: grant.credentialReference ?? null, credentialsExported: false }));
  };
  return Object.freeze({
    readAccount: ({ grant, now }) => call({ grant, scope: "account:read", method: "GET", path: "/portfolio/balance", run: () => client.getBalance(), now }),
    listPositions: ({ grant, now }) => call({ grant, scope: "positions:read", method: "GET", path: "/portfolio/positions", run: () => client.getPositions({ count_filter: "position" }), now }),
    listRestingOrders: ({ grant, now }) => call({ grant, scope: "orders:read", method: "GET", path: "/portfolio/orders?status=resting", run: () => client.getOrders({ status: "resting" }).then((orders) => ({ orders })), now }),
    listFills: ({ grant, sinceTs, now }) => call({ grant, scope: "orders:read", method: "GET", path: "/portfolio/fills", run: () => client.getFills({ min_ts: sinceTs }).then((fills) => ({ fills, cursor: fills.reduce((max, fill) => Math.max(max, Math.floor(Date.parse(fill.created_time) / 1000) || 0), sinceTs ?? 0) })), now }),
    preflightOrder: async ({ grant, contract, order, now = new Date().toISOString() }) => {
      const verdict = await admitUnderContract({ grant, contract, order, now });
      return Object.freeze(identify({ type: "KalshiOrderPreflight", version: 1, venue: "kalshi", grant: grant.id, principalContract: contract.id, order: clean(order), verdict, observedAt: now }));
    },
    placeOrder: async ({ grant, contract, order, now = new Date().toISOString() }) => {
      const verdict = await admitUnderContract({ grant, contract, order, now });
      if (!verdict.ok) return Object.freeze(identify({ type: "KalshiVenueOperationReceipt", version: 1, venue: "kalshi", grant: grant.id, scope: "orders:live", method: "POST", path: "/portfolio/events/orders",
        outcome: "refused-by-contract", status: null, observedAt: now, payload: null, error: { code: "principal-contract-refused", detail: verdict.reason, venueWrite: false }, credentialReference: grant.credentialReference ?? null, credentialsExported: false }));
      return call({ grant, scope: "orders:live", method: "POST", path: "/portfolio/events/orders", operation: { order }, run: () => client.createOrder({ ...order }), now });
    },
    cancelOrder: ({ grant, orderId, ticker, now }) => {
      if (typeof orderId !== "string" || orderId.length === 0) throw new TypeError("order-id-required");
      if (typeof ticker !== "string" || ticker.length === 0) throw new TypeError("kalshi-order-ticker-required");
      return call({ grant, scope: "orders:live", method: "DELETE", path: `/portfolio/events/orders/${encodeURIComponent(orderId)}`, operation: { orderId, ticker }, run: () => client.cancelOrder(orderId, ticker), now });
    },
  });
}
