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
import { semanticIdOf } from "@red-cup-engineering/computer-content-address-engineering-services-section/semantic-content-identity";
import {
  kalshiRiskContractBounds, kalshiOrderRiskCents,
  kalshiRestingRiskCents, kalshiAccountRiskInputs,
  kalshiUsdCeilCents, kalshiPriceCents, kalshiCountNumber,
} from './kalshi-risk-law.mjs';

const semanticId = semanticIdOf("brokerage.pluggable-venue-adapter.record");
const identify = (body) => ({ id: semanticId(body), ...body });
const CREDENTIAL_FIELDS = new Set(["authorization", "apikey", "apikeyid", "apisecret", "clientid", "clientsecret", "secret", "token", "accesstoken", "refreshtoken", "privatekey", "privatekeypath", "password"]);
const credentialField = (key) => { const normalized = String(key).toLowerCase().replace(/[-_\s]/gu, ""); return [...CREDENTIAL_FIELDS, "apisecretkey"].some((suffix) => normalized === suffix || normalized.endsWith(suffix)); };
function rejectCredentials(value, seen = new Set()) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); for (const [key, member] of Object.entries(value)) { if (credentialField(key)) throw new TypeError("credential-bearing-venue-request-refused"); rejectCredentials(member, seen); } }
function admit(grant, scope, operation, now) { rejectCredentials(operation); const at = Date.parse(now), expiry = Date.parse(grant?.validUntil); if (!Number.isFinite(at) || !Number.isFinite(expiry)) throw new TypeError("authority-time-invalid"); if (grant?.type !== "RevocableBrokerageAuthorityGrant" || grant.revoked === true) throw new TypeError("current-authority-grant-required"); if (grant.adapter !== "kalshi") throw new TypeError("kalshi-authority-required"); if (at >= expiry) throw new TypeError("authority-expired"); if (!grant.scopes?.includes(scope)) throw new TypeError("venue-operation-scope-refused"); return grant; }
function clean(value, seen = new Set()) { if (!value || typeof value !== "object") return value; if (seen.has(value)) return null; seen.add(value); if (Array.isArray(value)) return value.map((member) => clean(member, seen)); return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialField(key)).map(([key, member]) => [key, clean(member, seen)])); }

// Exact price/quantity arithmetic belongs to the Kalshi risk law; a Number
// conversion here could turn missing risk limits into NaN and fail admission open.

/**
 * The principal contract's verdict on one order, against an account reading. Pure.
 * @returns {{ok: true, orderRiskCents: number, openRiskCents: number, eventRiskCents: number} | {ok: false, reason: string}}
 */
export function admitKalshiOrderUnderContract({ contract, account, order } = {}) {
  if (contract?.type !== "PrincipalBrokerageServiceContract")
    return { ok: false, reason: "principal-contract-required" };
  // Any missing risk cap or observation MUST throw before venue placement.
  // BigInt comparisons are exact and never silently evaluate against NaN.
  const limits = kalshiRiskContractBounds(contract);
  const observed = kalshiAccountRiskInputs(account);
  if (typeof order?.ticker !== 'string' || !order.ticker.includes('-') ||
      order.ticker.endsWith('-'))
    throw new TypeError('event-bound-kalshi-order-ticker-required');
  const eventTicker = eventOf(order.ticker);
  const orderRiskCents = BigInt(kalshiOrderRiskCents(order));
  const openRiskCents = observed.positions.reduce((sum,row)=>sum+row.costCents,0n)
    + observed.resting.reduce((sum,row)=>sum+row.riskCents,0n);
  const eventRiskCents = observed.positions
    .filter(row=>row.eventTicker===eventTicker)
    .reduce((sum,row)=>sum+row.costCents,0n)
    + observed.resting
      .filter(row=>row.eventTicker===eventTicker)
      .reduce((sum,row)=>sum+row.riskCents,0n);
  const money=value=>value.toString();
  if (BigInt(limits.capitalCents) - observed.equityCents >= BigInt(limits.maximumLossCents))
    return { ok:false,reason:`loss boundary reached: equity ${money(observed.equityCents)}c against capital ${limits.capitalCents}c and maximum loss ${limits.maximumLossCents}c` };
  if (orderRiskCents > BigInt(limits.maximumOrderCents))
    return { ok:false,reason:`order risk ${money(orderRiskCents)}c above the contract's ${limits.maximumOrderCents}c` };
  if (openRiskCents + orderRiskCents > BigInt(limits.maximumAggregateCents))
    return { ok:false,reason:`open risk ${money(openRiskCents+orderRiskCents)}c above the contract's ${limits.maximumAggregateCents}c` };
  if (eventRiskCents + orderRiskCents > BigInt(limits.maximumEventCents))
    return { ok:false,reason:`event ${eventTicker} risk ${money(eventRiskCents+orderRiskCents)}c above the contract's fractional concentration limit` };
  if (orderRiskCents > observed.freeCashCents)
    return { ok:false,reason:`order risk ${money(orderRiskCents)}c above free cash ${money(observed.freeCashCents)}c` };
  if (openRiskCents > BigInt(Number.MAX_SAFE_INTEGER) ||
      eventRiskCents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('observed-open-risk-exceeds-safe-integer-cents');
  return {
    ok: true, orderRiskCents:Number(orderRiskCents),
    openRiskCents:Number(openRiskCents),eventRiskCents:Number(eventRiskCents),
  };
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
  // Absence of a source balance is UNKNOWN, not a zero-value portfolio.
  if (!Number.isSafeInteger(balance?.balance)) throw new TypeError("kalshi-balance-required");
  if (!Number.isSafeInteger(balance.portfolio_value)) throw new TypeError("kalshi-portfolio-value-required");
  const marketPositions = Array.isArray(positions) ? positions : positions?.market_positions;
  const restingOrders = Array.isArray(orders) ? orders : orders?.orders;
  if (!Array.isArray(marketPositions) || !Array.isArray(restingOrders))
    throw new TypeError('complete-observed-kalshi-positions-and-orders-required');
  const held = marketPositions.flatMap(row => {
    if (typeof row?.ticker !== 'string' || !row.ticker.includes('-'))
      throw new TypeError('kalshi-position-ticker-invalid');
    let signed;
    try {signed=kalshiCountNumber(row.position_fp,{signed:true});}
    catch {throw new TypeError('kalshi-position-value-invalid');}
    if (signed===0)return [];
    return [{ticker:row.ticker,eventTicker:eventOf(row.ticker),
      side:signed<0?'no':'yes',contracts:Math.abs(signed),
      costCents:kalshiUsdCeilCents(row.market_exposure_dollars)}];
  });
  const resting = restingOrders.map(order => {
    if (typeof order?.ticker !== 'string' || !order.ticker.includes('-') ||
        typeof order.order_id!=='string' || !order.order_id)
      throw new TypeError('kalshi-resting-order-identity-required');
    return {
      orderId:order.order_id,ticker:order.ticker,eventTicker:eventOf(order.ticker),
      bookSide:order.book_side ?? (
        (order.side==='yes'&&order.action==='sell')||
        (order.side==='no'&&order.action==='buy')?'ask':'bid'),
      priceCents:kalshiPriceCents(order.yes_price_dollars),
      // Preserve the exact ORIGINAL source decimals for collateral calculation.
      yesPriceDollars:String(order.yes_price_dollars),
      countDecimal:String(order.remaining_count_fp),
      count:kalshiCountNumber(order.remaining_count_fp),
      expiration:order.expiration_time??null,
    };
  });
  if(held.some(row=>!Number.isSafeInteger(row.costCents)||row.costCents<0))
    throw new TypeError('kalshi-position-value-invalid');
  if(resting.some(row=>!['bid','ask'].includes(row.bookSide)))
    throw new TypeError('kalshi-resting-order-value-invalid');
  const collateral=resting.reduce((sum,row)=>sum+BigInt(kalshiRestingRiskCents({
    ...row,count:row.countDecimal,
  })),0n);
  const cashCents=balance.balance,portfolioCents=balance.portfolio_value;
  const withinSafe=x=>x<=BigInt(Number.MAX_SAFE_INTEGER)&&x>=BigInt(Number.MIN_SAFE_INTEGER);
  const equity=BigInt(cashCents)+BigInt(portfolioCents);
  const freeCash=BigInt(cashCents)-collateral;
  if(![equity,freeCash,collateral].every(withinSafe))
    throw new RangeError('kalshi-account-cent-aggregation-overflow');
  return {
    cashCents,equityCents:Number(equity),freeCashCents:Number(freeCash),
    restingCollateralCents:Number(collateral),positions:held,resting,
  };
}

/**
 * @param {{client: {getBalance: Function, getPositions: Function, getOrders: Function, createOrder: Function, cancelOrder: Function}}} options
 *   client: a createKalshiClient instance, already bound to its credential by the custodian.
 */
export function createKalshiAdapter({ client } = {}) {
  for (const method of ["getBalance", "getPositions", "getOrders", "getFills", "createOrder", "cancelOrder"]) if (typeof client?.[method] !== "function") throw new TypeError("kalshi-adapter-configuration-invalid");
  const observe = async () => {
    const balance=await client.getBalance();
    const positions=await client.getPositions({count_filter:"position"});
    const orders=await client.getOrders({status:"resting"});
    // A missing API response is not proof of an empty inventory or order book.
    if (!balance || positions===null || positions===undefined ||
        orders===null || orders===undefined)
      throw new TypeError('complete-current-kalshi-venue-reading-required');
    return normalizeKalshiAccount({balance,positions,orders});
  };
  const checkOrder = (order) => {
    if (!order || (order.side !== "bid" && order.side !== "ask")) throw new TypeError("kalshi-order-side-invalid");
    if (typeof order.ticker !== "string" || order.ticker.length === 0) throw new TypeError("kalshi-order-ticker-required");
    try {kalshiOrderRiskCents(order);}
    catch(error) {throw new TypeError("kalshi-order-count-or-price-invalid: "+error.message);}
    if (typeof order.clientOrderId !== "string" || order.clientOrderId.length === 0) throw new TypeError("kalshi-client-order-id-required");
  };
  const contractOf = (grant, contract) => { if (contract?.id !== grant?.principalContract) throw new TypeError("grant-names-another-contract"); return contract; };
  // The contract's verdict, from an account reading taken now; refused orders never reach the venue.
  const admitUnderContract = async ({ grant, contract, order, now }) => {
    admit(grant, "orders:live", { order }, now);
    checkOrder(order);
    const boundContract=contractOf(grant,contract);
    // Check the principal's entire mandate before spending a venue read.
    kalshiRiskContractBounds(boundContract);
    return admitKalshiOrderUnderContract({contract:boundContract,account:await observe(),order});
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
