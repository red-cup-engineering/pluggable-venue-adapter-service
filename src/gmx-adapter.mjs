/**
 * The GMX v2 venue adapter on the venue authority chain (Arbitrum 42161, Avalanche 43114).
 *
 * Same discipline as alpaca-adapter.mjs and kalshi-adapter.mjs: every operation is admitted against a
 * `RevocableBrokerageAuthorityGrant` (current, unrevoked, unexpired, adapter "gmx", carrying the operation's
 * scope), requests that carry credential fields are refused, response fields that look like credentials are
 * dropped, and every operation returns a frozen, content-identified receipt.
 *
 * What differs is the venue: GMX is a set of contracts, not an HTTP API, and it never takes an order from us.
 * So the adapter has TWO halves and no third:
 *   - reads (account:read, positions:read, orders:read): public JSON-RPC `eth_getBalance` / `eth_call`
 *     through an injected `rpc`, and GMX's public REST through an injected `fetchJson`. No key, no signature.
 *   - builds (orders:build, deposits:build): pure calldata construction. A build returns UNSIGNED transaction
 *     requests ({chainId, from, to, value, data}) and the ERC-20 approvals they need; it signs nothing, sends
 *     nothing and holds no key. Signing belongs to the custodian that holds the grant's
 *     `credentialReference` (key-management sign-with-wallet), which must then re-check the same limits.
 * There is deliberately no `sign`, `send` or `placeOrder` here. The receipt says `signed: false`.
 *
 * Limits come from the grant: `limits.maxValuePerTransactionUsd` is checked against the pre-trade USD value of
 * the collateral a build moves, `limits.maxLeverage` against size / collateral, and `limits.allowedContracts`
 * must name every contract a build touches (empty or absent allows none: fail closed). The existing
 * 0x224C...078d grant names `eip155:8453`; building for Arbitrum needs its own grant with `chainId: 42161`,
 * because widening is a new grant, never an edit.
 *
 * Contract addresses are gmx-io/gmx-interface sdk/src/configs/contracts.ts (master, read 2026-10-03). ABI shapes
 * (CreateOrderParams with `autoCancel`/`referralCode`/`dataList`, CreateDepositParams, CreateGlvDepositParams,
 * Position.Props with `pendingImpactAmount`) are the verified ExchangeRouter 0x7dE3...83f1, GlvRouter
 * 0x1675...A712 and SyntheticsReader 0xfA26...4184 ABIs on Arbiscan/Blockscout. A contract upgrade changes
 * shapes: the adapter pins the function signatures it encodes in `GMX_SIGNATURES`, and the shared ethers codec encodes them.
 */
import { semanticIdOf } from "@red-cup-engineering/computer-data-engineering-services-section/semiotic-expression-notation/semantic-content-identity";
import { allocationFor, allocationsFor } from '@red-cup-engineering/mandate-portfolio-allocation-service/market-game';

const semanticId = semanticIdOf("brokerage.pluggable-venue-adapter.record");
const identify = (body) => ({ id: semanticId(body), ...body });
const CREDENTIAL_FIELDS = new Set(["authorization", "apikey", "apikeyid", "apisecret", "clientid", "clientsecret", "secret", "token", "accesstoken", "refreshtoken", "privatekey", "privatekeypath", "mnemonic", "seedphrase", "keystore", "password"]);
// "token" is a credential word in HTTP APIs but an address field name here (initialCollateralToken, longToken), so
// only a key that IS or ENDS WITH a credential word is refused, except the ABI/venue fields that end in "Token".
const NOT_CREDENTIAL = /^(initialcollateraltoken|initiallongtoken|initialshorttoken|collateraltoken|longtoken|shorttoken|indextoken|glvtoken|markettoken|token|tokens|tokenaddress)$/u;
const credentialField = (key) => { const normalized = String(key).toLowerCase().replace(/[-_\s]/gu, ""); if (NOT_CREDENTIAL.test(normalized)) return false; return [...CREDENTIAL_FIELDS, "apisecretkey"].some((word) => normalized === word || normalized.endsWith(word)); };
function rejectCredentials(value, seen = new Set()) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); for (const [key, member] of Object.entries(value)) { if (credentialField(key)) throw new TypeError("credential-bearing-venue-request-refused"); rejectCredentials(member, seen); } }
function clean(value, seen = new Set()) { if (typeof value === "bigint") return value.toString(); if (!value || typeof value !== "object") return value; if (seen.has(value)) return null; seen.add(value); if (Array.isArray(value)) return value.map((member) => clean(member, seen)); return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialField(key)).map(([key, member]) => [key, clean(member, seen)])); }

import { GMX_CHAINS, GMX_SIGNATURES, ORDER_TYPE, T_ORDER_PARAMS, T_DEPOSIT_PARAMS, T_GLV_DEPOSIT_PARAMS, T_GLV_WITHDRAWAL_PARAMS } from "../data/gmx/contracts.mjs";
import { encode, integer, selectorOf } from "./gmx/abi.mjs";
import { decodeAccountPositions, decodeAccountOrders, usdToE30 } from "./gmx/model.mjs";
import { createGmxPublicReader } from "./gmx/public-reader.mjs";
import { GMX_REWARDS } from "../data/gmx/rewards.mjs";
import { Interface } from "ethers";
export { GMX_CHAINS, GMX_SIGNATURES, ORDER_TYPE } from "../data/gmx/contracts.mjs";
export { encode, decode, keccak256, selectorOf } from "./gmx/abi.mjs";
export { decodeAccountPositions, decodeAccountOrders, normalizeGmxAccount, usdToE30, e30ToUsd, gmxMarketCarry, gmxQuoteCarry } from "./gmx/model.mjs";
const ZERO = "0x0000000000000000000000000000000000000000";
const SELECTOR = Object.fromEntries(Object.entries(GMX_SIGNATURES).filter(([name]) => name !== "gasPrice").map(([name, signature]) => [name, selectorOf(signature)]));
export const GMX_SELECTORS = Object.freeze({ ...SELECTOR });
const call = (name, types, values) => `${SELECTOR[name]}${encode(types, values)}`;
const fundedLegs = (legs) => legs.filter(([, amount]) => {
  const quantity = integer(amount);
  if (quantity < 0n) throw new RangeError("uint-negative");
  return quantity > 0n;
});

/* ------------------------------------------------------------------ admission */
function admit(grant, scope, operation, now, chainId) {
  rejectCredentials(operation);
  const at = Date.parse(now), expiry = Date.parse(grant?.validUntil);
  if (!Number.isFinite(at) || !Number.isFinite(expiry)) throw new TypeError("authority-time-invalid");
  if (grant?.type !== "RevocableBrokerageAuthorityGrant" || grant.revoked === true) throw new TypeError("current-authority-grant-required");
  if (grant.adapter !== "gmx") throw new TypeError("gmx-authority-required");
  if (at >= expiry) throw new TypeError("authority-expired");
  if (!grant.scopes?.includes(scope)) throw new TypeError("venue-operation-scope-refused");
  if (Number(grant.chainId) !== chainId) throw new TypeError("grant-chain-mismatch");
  if (!/^0x[0-9a-fA-F]{40}$/u.test(grant.account ?? "")) throw new TypeError("grant-account-required");
  return grant;
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function enforceContracts(grant, touched) {
  const allowed = (grant.limits?.allowedContracts ?? []).map((a) => a.toLowerCase());
  for (const contract of touched) if (!allowed.includes(contract.toLowerCase())) throw new TypeError(`contract-not-allowed-by-grant:${contract}`);
}
function enforceValue(grant, valueUsd) {
  const cap = grant.limits?.maxValuePerTransactionUsd;
  if (!(Number.isFinite(cap) && cap > 0)) throw new TypeError("grant-value-limit-required");
  if (!(valueUsd > 0)) throw new RangeError("order-value-invalid");
  if (valueUsd > cap + 1e-9) throw new RangeError(`order-value-exceeds-grant-limit:${valueUsd}>${cap}`);
}

/**
 * @param {{chainId?: 42161|43114, rpc: (request: {method: string, params: unknown[]}) => Promise<unknown>, fetchJson?: (url: string) => Promise<unknown>}} options
 *   rpc: public JSON-RPC, e.g. ({method, params}) => fetch(url, POST {jsonrpc, id, method, params}).then(r => r.json()).then(b => b.result).
 *   fetchJson: GET returning parsed JSON, used for GMX's public REST (markets/info, prices/tickers).
 */
export function createGmxAdapter({ chainId = 42161, rpc, fetchJson, blockTag = "latest" } = {}) {
  const chain = GMX_CHAINS[chainId];
  if (!chain || typeof rpc !== "function") throw new TypeError("gmx-adapter-configuration-invalid");
  const ethCall = (to, data) => rpc({ method: "eth_call", params: [{ to, data }, blockTag] });
  const balanceOf = async (token, who) => BigInt(await ethCall(token, call("balanceOf", ["address"], [who])));
  const allowanceOf = async (token, owner, spender) => BigInt(await ethCall(token, call("allowance", ["address", "address"], [owner, spender])));

  const read = async ({ grant, scope, method, path, run, now = new Date().toISOString(), operation = {} }) => {
    admit(grant, scope, { method, path, ...operation }, now, chainId);
    let outcome = "accepted", payload, error = null;
    try { payload = await run(); } catch (failure) { outcome = "refused"; error = { code: failure?.code ?? "venue-read-failed", detail: String(failure?.message ?? failure) }; }
    return Object.freeze(identify({ type: "GmxVenueOperationReceipt", version: 1, venue: "gmx", chainId, grant: grant.id, scope, method, path, outcome, observedAt: now, payload: clean(payload) ?? null, error, signed: false, credentialReference: grant.credentialReference ?? null, credentialsExported: false }));
  };
  const build = ({ grant, scope, kind, now = new Date().toISOString(), operation, run }) => {
    admit(grant, scope, { kind, ...operation }, now, chainId);
    const built = run(grant);
    enforceContracts(grant, [...built.transactions.map((tx) => tx.to), ...built.approvals.map((a) => a.spender)]);
    enforceValue(grant, built.valueUsd);
    return built;
  };
  const seal = (grant, scope, kind, now, built) => Object.freeze(identify({ type: "GmxUnsignedTransactionPlan", version: 1, venue: "gmx", chainId, grant: grant.id, scope, kind, builtAt: now, account: grant.account,
    valueUsd: built.valueUsd, approvals: built.approvals, transactions: built.transactions, notes: built.notes ?? [], signed: false, broadcast: false, credentialReference: grant.credentialReference ?? null, credentialsExported: false }));

  /** multicall([sendWnt(vault, fee), sendTokens(token, vault, amount)?, create(...)]) -> one unsigned transaction. */
  const bundle = ({ router, vault, executionFeeWei, token, amount, creation }) => {
    const calls = [call("sendWnt", ["address", "uint256"], [vault, executionFeeWei])];
    if (token && integer(amount) > 0n) calls.push(call("sendTokens", ["address", "address", "uint256"], [token, vault, amount]));
    calls.push(creation);
    return { to: router, value: `0x${integer(executionFeeWei).toString(16)}`, data: call("multicall", [{ array: "bytes" }], [calls]) };
  };
  const approvalFor = async (grant, token, amount, spender) => {
    const current = await allowanceOf(token, grant.account, spender);
    return current >= integer(amount) ? [] : [{ type: "erc20-approve", token, spender, amount: integer(amount).toString(), currentAllowance: current.toString(), transaction: { chainId, from: grant.account, to: token, value: "0x0", data: call("approve", ["address", "uint256"], [spender, amount]) } }];
  };
  const requireFee = (fee) => { if (!(integer(fee) > 0n)) throw new RangeError("execution-fee-required"); return integer(fee); };

  return Object.freeze({
    chain,
    /** Claim accrued v1 fees to the account. No token approval, deposit, swap, or staking. */
    buildFeeClaim: ({ grant, valueUsd, now = new Date().toISOString() }) => {
      const rewards = GMX_REWARDS[chainId];
      if (!rewards) throw new RangeError("gmx-reward-deployment-unsupported");
      const built = build({ grant, scope: "rewards:build", kind: "fee-claim", now, operation: { valueUsd }, run: () => ({
        valueUsd, approvals: [], transactions: [{ chainId, from: grant.account, to: rewards.rewardRouter, value: "0x0",
          data: new Interface(["function claimFees()"]).encodeFunctionData("claimFees") }],
      }) });
      return seal(grant, "rewards:build", "fee-claim", now, built);
    },
    /** Native gas balance and the stablecoin/collateral token balances named in `tokens`. */
    readAccount: ({ grant, tokens = [chain.usdc, chain.wnt], now }) => read({ grant, scope: "account:read", method: "eth_getBalance+balanceOf", path: `eip155:${chainId}/${grant.account}`, now, operation: { tokens },
      run: async () => ({ account: grant.account, nativeWei: BigInt(await rpc({ method: "eth_getBalance", params: [grant.account, blockTag] })).toString(), tokens: await Promise.all(tokens.map(async (token) => ({ token, raw: (await balanceOf(token, grant.account)).toString() }))) }) }),
    listPositions: ({ grant, now }) => read({ grant, scope: "positions:read", method: "eth_call", path: `${chain.reader}#getAccountPositions`, now,
      run: async () => { const positions = decodeAccountPositions(await ethCall(chain.reader, call("getAccountPositions", ["address", "address", "uint256", "uint256"], [chain.dataStore, grant.account, 0, 100]))); return { positions, range: { start: 0, end: 100, complete: positions.length < 100 } }; } }),
    listOrders: ({ grant, now }) => read({ grant, scope: "orders:read", method: "eth_call", path: `${chain.reader}#getAccountOrders`, now,
      run: async () => { const orders = decodeAccountOrders(await ethCall(chain.reader, call("getAccountOrders", ["address", "address", "uint256", "uint256"], [chain.dataStore, grant.account, 0, 100]))); return { orders, range: { start: 0, end: 100, complete: orders.length < 100 } }; } }),
    /** GMX public REST: market list and oracle tickers, for sizing and mark values. */
    readMarkets: ({ grant, now }) => {
      if (typeof fetchJson !== "function") throw new TypeError("gmx-adapter-fetch-required");
      return read({ grant, scope: "account:read", method: "GET", path: `${chain.api}/markets/info`, now, run: async () => { const observed = await createGmxPublicReader({ chainId, fetchJson }).get("/markets/info"); return { markets: observed.body.markets, sourceEndpoint: observed.url }; } });
    },

    /**
     * Build an UNSIGNED perpetual order. `order` = {market, collateralToken, collateralAmount (bigint-ish base units), collateralUsd (pre-trade quote),
     *   sizeDeltaUsd, isLong, acceptablePriceE30, executionFeeWei, orderType?: MarketIncrease|MarketDecrease, triggerPriceE30?, validFromTime?, referralCode?}.
     * The collateral is pulled by the Router from `grant.account` after the returned ERC-20 approval, so the approval is part of the plan.
     */
    buildPerpOrder: async ({ grant, order, marketDecision, now = new Date().toISOString() }) => {
      const type = order.orderType ?? ORDER_TYPE.MarketIncrease;
      if (![ORDER_TYPE.MarketIncrease, ORDER_TYPE.MarketDecrease, ORDER_TYPE.LimitIncrease, ORDER_TYPE.LimitDecrease, ORDER_TYPE.StopLossDecrease].includes(type)) throw new TypeError("gmx-order-type-unsupported");
      if (typeof order.isLong !== "boolean" || !/^0x[0-9a-fA-F]{40}$/u.test(order.market ?? "")) throw new TypeError("gmx-order-market-and-side-required");
      const increasing = type === ORDER_TYPE.MarketIncrease || type === ORDER_TYPE.LimitIncrease;
      const fee = requireFee(order.executionFeeWei);
      const size = integer(order.sizeDeltaUsd);
      if (increasing) {
        if (marketDecision && Math.ceil(Number(order.collateralUsd) * 100 - 1e-9) > allocationFor(marketDecision, { venue: 'evm', principal: grant.principal, instrument: order.market, side: order.isLong ? 'long' : 'short', chainId, protocol: 'gmx', at: now })) throw new RangeError('gmx-collateral-exceeds-shared-market-allocation');
        if (!(integer(order.collateralAmount) > 0n) || !(Number(order.collateralUsd) > 0)) throw new RangeError("gmx-collateral-required");
        const leverage = e30ToUsd(size) / Number(order.collateralUsd);
        if (marketDecision) {
          const funded = allocationsFor(marketDecision, { venue: 'evm', principal: grant.principal, instrument: order.market, side: order.isLong ? 'long' : 'short', chainId, protocol: 'gmx', at: now });
          if (funded.length !== 1 || Math.abs(funded[0].leverage - leverage) > 1e-8 || !same(funded[0].collateralToken, order.collateralToken)) throw new RangeError('gmx-payoff-model-and-order-exposure-differ');
        }
        const maxLeverage = grant.limits?.maxLeverage;
        if (!(Number.isFinite(maxLeverage) && maxLeverage >= 1)) throw new TypeError("grant-leverage-limit-required");
        if (leverage > maxLeverage + 1e-9) throw new RangeError(`order-leverage-exceeds-grant-limit:${leverage}>${maxLeverage}`);
      }
      const params = [[grant.account, grant.account, ZERO, ZERO, order.market, order.collateralToken, order.swapPath ?? []],
        [size, increasing ? integer(order.collateralAmount) : integer(order.collateralAmount ?? 0), integer(order.triggerPriceE30 ?? 0), integer(order.acceptablePriceE30), fee, 0n, 0n, integer(order.validFromTime ?? 0)],
        type, 0, order.isLong, false, true, order.referralCode ?? `0x${"0".repeat(64)}`, []];
      const spend = increasing ? Number(order.collateralUsd) : Number(order.collateralUsd ?? order.sizeUsd ?? 0.01);
      const built = build({ grant, scope: "orders:build", kind: "perp-order", now, operation: { order }, run: () => ({ valueUsd: spend, approvals: [], notes: [], transactions: [{ chainId, from: grant.account, ...bundle({ router: chain.exchangeRouter, vault: chain.orderVault, executionFeeWei: fee, token: increasing ? order.collateralToken : null, amount: increasing ? order.collateralAmount : 0, creation: call("createOrder", [T_ORDER_PARAMS], [params]) }) }] }) });
      const approvals = increasing ? await approvalFor(grant, order.collateralToken, order.collateralAmount, chain.router) : [];
      if (approvals.length) enforceContracts(grant, [order.collateralToken]);
      const sealed = seal(grant, "orders:build", "perp-order", now, { ...built, approvals, notes: ["executionFee is held by the OrderVault and the unused part is refunded by GMX; the keeper executes after the transaction confirms.", "sign and send is the custodian's step; this plan is unsigned."] });
      if (!marketDecision) return sealed;
      const { id: oldId, ...body } = sealed; void oldId;
      return Object.freeze(identify({ ...body, marketDecision: marketDecision.id }));
    },
    /** Build an UNSIGNED GM-pool deposit: `deposit` = {market, initialLongToken, initialShortToken, longAmount, shortAmount, valueUsd, minMarketTokens, executionFeeWei}. */
    buildGmDeposit: async ({ grant, deposit, now = new Date().toISOString() }) => {
      const fee = requireFee(deposit.executionFeeWei);
      const params = [[grant.account, ZERO, ZERO, deposit.market, deposit.initialLongToken, deposit.initialShortToken, [], []], integer(deposit.minMarketTokens ?? 0), false, fee, 0n, []];
      const legs = fundedLegs([[deposit.initialLongToken, deposit.longAmount ?? 0], [deposit.initialShortToken, deposit.shortAmount ?? 0]]);
      if (legs.length === 0) throw new RangeError("gmx-deposit-amount-required");
      const built = build({ grant, scope: "deposits:build", kind: "gm-deposit", now, operation: { deposit }, run: () => {
        const calls = [call("sendWnt", ["address", "uint256"], [chain.depositVault, fee]), ...legs.map(([token, amount]) => call("sendTokens", ["address", "address", "uint256"], [token, chain.depositVault, amount])), call("createDeposit", [T_DEPOSIT_PARAMS], [params])];
        return { valueUsd: Number(deposit.valueUsd), approvals: [], transactions: [{ chainId, from: grant.account, to: chain.exchangeRouter, value: `0x${fee.toString(16)}`, data: call("multicall", [{ array: "bytes" }], [calls]) }] };
      } });
      const approvals = (await Promise.all(legs.map(([token, amount]) => approvalFor(grant, token, amount, chain.router)))).flat();
      enforceContracts(grant, approvals.map((a) => a.token));
      return seal(grant, "deposits:build", "gm-deposit", now, { ...built, approvals, notes: ["GM deposits pay a deposit fee and price impact, then wait for keeper execution; set minMarketTokens from a fresh quote."] });
    },
    /** Build an UNSIGNED GLV deposit (GlvRouter): `deposit` = {glv, market, initialLongToken, initialShortToken, longAmount, shortAmount, valueUsd, minGlvTokens, executionFeeWei}. */
    buildGlvDeposit: async ({ grant, deposit, now = new Date().toISOString() }) => {
      const fee = requireFee(deposit.executionFeeWei);
      const params = [[deposit.glv, deposit.market, grant.account, ZERO, ZERO, deposit.initialLongToken, deposit.initialShortToken, [], []], integer(deposit.minGlvTokens ?? 0), fee, 0n, false, false, []];
      const legs = fundedLegs([[deposit.initialLongToken, deposit.longAmount ?? 0], [deposit.initialShortToken, deposit.shortAmount ?? 0]]);
      if (legs.length === 0) throw new RangeError("gmx-deposit-amount-required");
      const built = build({ grant, scope: "deposits:build", kind: "glv-deposit", now, operation: { deposit }, run: () => {
        const calls = [call("sendWnt", ["address", "uint256"], [chain.glvVault, fee]), ...legs.map(([token, amount]) => call("sendTokens", ["address", "address", "uint256"], [token, chain.glvVault, amount])), call("createGlvDeposit", [T_GLV_DEPOSIT_PARAMS], [params])];
        return { valueUsd: Number(deposit.valueUsd), approvals: [], transactions: [{ chainId, from: grant.account, to: chain.glvRouter, value: `0x${fee.toString(16)}`, data: call("multicall", [{ array: "bytes" }], [calls]) }] };
      } });
      const approvals = (await Promise.all(legs.map(([token, amount]) => approvalFor(grant, token, amount, chain.router)))).flat();
      enforceContracts(grant, approvals.map((a) => a.token));
      return seal(grant, "deposits:build", "glv-deposit", now, { ...built, approvals, notes: ["GlvRouter pulls tokens through the same Router (0x7452...) approval; GLV deposits share GM deposit fees and wait for keeper execution."] });
    },
    /** Build an UNSIGNED GLV withdrawal: `withdrawal` = {glv, glvAmount, valueUsd, minLongTokenAmount, minShortTokenAmount, executionFeeWei}. */
    buildGlvWithdrawal: async ({ grant, withdrawal, now = new Date().toISOString() }) => {
      const fee = requireFee(withdrawal.executionFeeWei);
      const params = [[grant.account, ZERO, ZERO, withdrawal.market, withdrawal.glv, [], []], integer(withdrawal.minLongTokenAmount ?? 0), integer(withdrawal.minShortTokenAmount ?? 0), false, fee, 0n, []];
      if (!(integer(withdrawal.glvAmount) > 0n)) throw new RangeError("gmx-withdrawal-amount-required");
      const built = build({ grant, scope: "deposits:build", kind: "glv-withdrawal", now, operation: { withdrawal }, run: () => {
        const calls = [call("sendWnt", ["address", "uint256"], [chain.glvVault, fee]), call("sendTokens", ["address", "address", "uint256"], [withdrawal.glv, chain.glvVault, withdrawal.glvAmount]), call("createGlvWithdrawal", [T_GLV_WITHDRAWAL_PARAMS], [params])];
        return { valueUsd: Number(withdrawal.valueUsd), approvals: [], transactions: [{ chainId, from: grant.account, to: chain.glvRouter, value: `0x${fee.toString(16)}`, data: call("multicall", [{ array: "bytes" }], [calls]) }] };
      } });
      const approvals = await approvalFor(grant, withdrawal.glv, withdrawal.glvAmount, chain.router);
      enforceContracts(grant, approvals.map((a) => a.token));
      return seal(grant, "deposits:build", "glv-withdrawal", now, { ...built, approvals });
    },
  });
}

/** The contracts a grant's `limits.allowedContracts` must list for this adapter's builds on a chain (the fail-closed list). */
export function requiredAllowedContracts(chainId, { tokens = [] } = {}) {
  const chain = GMX_CHAINS[chainId];
  if (!chain) throw new RangeError("gmx-chain-unsupported");
  return [chain.exchangeRouter, chain.glvRouter, chain.router, ...tokens];
}
