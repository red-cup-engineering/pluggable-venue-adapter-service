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
 * shapes: the adapter pins the function signatures it encodes in `GMX_SIGNATURES`, and tests pin their selectors.
 */
import { semanticIdOf } from "@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity";
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

/* ------------------------------------------------------------------ keccak-256 (for selectors; node:crypto has only NIST SHA-3) */
const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
const ROTATION = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const rotl = (value, shift) => (shift === 0 ? value : ((value << BigInt(shift)) | (value >> BigInt(64 - shift))) & MASK);
function keccakF(state) {
  for (let round = 0; round < 24; round += 1) {
    const column = Array.from({ length: 5 }, (_, x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    for (let x = 0; x < 5; x += 1) { const d = column[(x + 4) % 5] ^ rotl(column[(x + 1) % 5], 1); for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= d; }
    const next = new Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) next[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], ROTATION[x][y]);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = next[x + 5 * y] ^ (~next[((x + 1) % 5) + 5 * y] & MASK & next[((x + 2) % 5) + 5 * y]);
    state[0] ^= ROUND_CONSTANTS[round];
  }
}
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : Uint8Array.from(input);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) { let word = 0n; for (let b = 7; b >= 0; b -= 1) word = (word << 8n) | BigInt(padded[offset + lane * 8 + b]); state[lane] ^= word; }
    keccakF(state);
  }
  let hex = "";
  for (let lane = 0; lane < 4; lane += 1) for (let b = 0; b < 8; b += 1) hex += Number((state[lane] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return `0x${hex}`;
}
export const selectorOf = (signature) => keccak256(signature).slice(0, 10);

/* ------------------------------------------------------------------ minimal ABI coder: 'address' 'uintN' 'intN' 'bool' 'bytes32' 'bytes', {tuple:[...]}, {array:T} */
const ZERO = "0x0000000000000000000000000000000000000000";
const hex = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const isDynamic = (type) => type === "bytes" || (typeof type === "object" && (type.array !== undefined || type.tuple.some(isDynamic)));
const address = (value) => { if (!/^0x[0-9a-fA-F]{40}$/u.test(value ?? "")) throw new TypeError("evm-address-invalid"); return value.slice(2).toLowerCase().padStart(64, "0"); };
function encodeOne(type, value) {
  if (type === "address") return address(value);
  if (type === "bool") return hex(value ? 1 : 0);
  if (typeof type === "string" && /^u?int\d*$/u.test(type)) { const big = BigInt(value); if (type.startsWith("u") && big < 0n) throw new RangeError("uint-negative"); return hex(big); }
  if (type === "bytes32") { if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw new TypeError("bytes32-invalid"); return value.slice(2).toLowerCase(); }
  if (type === "bytes") { const body = value.replace(/^0x/u, ""); return hex(body.length / 2) + body.padEnd(Math.ceil(body.length / 64) * 64, "0"); }
  if (type.array !== undefined) return hex(value.length) + encode(value.map(() => type.array), value);
  return encode(type.tuple, Array.isArray(value) ? value : type.tuple.map((_, index) => value[index]));
}
export function encode(types, values) {
  if (types.length !== values.length) throw new TypeError("abi-arity-mismatch");
  let head = "", tail = "";
  const headSize = types.reduce((sum, type) => sum + (isDynamic(type) ? 32 : staticWords(type) * 32), 0);
  types.forEach((type, index) => {
    const body = encodeOne(type, values[index]);
    if (isDynamic(type)) { head += hex(headSize + tail.length / 2); tail += body; } else head += body;
  });
  return head + tail;
}
function staticWords(type) { return typeof type === "object" && type.tuple !== undefined ? type.tuple.reduce((sum, member) => sum + staticWords(member), 0) : 1; }
function decodeOne(type, data, offset) {
  const word = (at) => BigInt(`0x${data.slice(at * 2, at * 2 + 64)}`);
  if (type === "address") return `0x${data.slice(offset * 2 + 24, offset * 2 + 64)}`;
  if (type === "bool") return word(offset) !== 0n;
  if (type === "bytes32") return `0x${data.slice(offset * 2, offset * 2 + 64)}`;
  if (typeof type === "string" && type.startsWith("int")) return BigInt.asIntN(256, word(offset));
  if (typeof type === "string") return word(offset);
  if (type.array !== undefined) { const length = Number(word(offset)); const base = offset + 32; const stride = isDynamic(type.array) ? 32 : staticWords(type.array) * 32; return Array.from({ length }, (_, i) => (isDynamic(type.array) ? decodeOne(type.array, data, base + Number(word(base + i * stride))) : decodeOne(type.array, data, base + i * stride))); }
  return decode(type.tuple, data, offset);
}
export function decode(types, data, start = 0) {
  const body = data.replace(/^0x/u, "");
  let cursor = start;
  return types.map((type) => {
    let value;
    if (isDynamic(type)) value = decodeOne(type, body, start + Number(BigInt(`0x${body.slice(cursor * 2, cursor * 2 + 64)}`))), cursor += 32;
    else value = decodeOne(type, body, cursor), cursor += staticWords(type) * 32;
    return value;
  });
}

/* ------------------------------------------------------------------ GMX contracts and function signatures */
export const GMX_CHAINS = Object.freeze({
  42161: Object.freeze({
    name: "arbitrum", api: "https://arbitrum-api.gmxinfra.io",
    dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8", exchangeRouter: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1", router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
    orderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5", depositVault: "0xF89e77e8Dc11691C9e8757e84aaFbCD8A67d7A55", withdrawalVault: "0x0628D46b5D145f183AdB6Ef1f2c97eD1C4701C55",
    reader: "0xfA26cBb46e2614609406de08CA1Dc7f70a684184", glvRouter: "0x167540D2DFF14120365CfDDF2F86e3045D4fa712", glvVault: "0x393053B58f9678C9c28c2cE941fF6cac49C3F8f9",
    wnt: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  }),
  43114: Object.freeze({
    name: "avalanche", api: "https://avalanche-api.gmxinfra.io",
    dataStore: "0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6", exchangeRouter: "0xc002Db96E682FFF6675966F959677285a0C45Efa", router: "0x820F5FfC5b525cD4d88Cd91aCf2c28F16530Cc68",
    orderVault: "0xD3D60D22d415aD43b7e64b510D86A30f19B1B12C", depositVault: "0x90c670825d0C62ede1c5ee9571d6d9a17A722DFF", withdrawalVault: "0xf5F30B10141E1F63FC11eD772931A8294a591996",
    reader: "0xa34320a507493C71Fe35E982e496F7C5d1a7fa02", glvRouter: "0x603B3D3aB077CA433b888c05fa59c777d5b6dCAD", glvVault: "0x527FB0bCfF63C47761039bB386cFE181A92a4701",
    wnt: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  }),
});
const T_ORDER_PARAMS = { tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", { array: "address" }] }, { tuple: ["uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, "uint8", "uint8", "bool", "bool", "bool", "bytes32", { array: "bytes32" }] };
const T_DEPOSIT_PARAMS = { tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "bool", "uint256", "uint256", { array: "bytes32" }] };
const T_GLV_DEPOSIT_PARAMS = { tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "uint256", "uint256", "bool", "bool", { array: "bytes32" }] };
const T_GLV_WITHDRAWAL_PARAMS = { tuple: [{ tuple: ["address", "address", "address", "address", "address", { array: "address" }, { array: "address" }] }, "uint256", "uint256", "bool", "uint256", "uint256", { array: "bytes32" }] };
export const GMX_SIGNATURES = Object.freeze({
  multicall: "multicall(bytes[])", sendWnt: "sendWnt(address,uint256)", sendTokens: "sendTokens(address,address,uint256)",
  createOrder: "createOrder(((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
  createDeposit: "createDeposit(((address,address,address,address,address,address,address[],address[]),uint256,bool,uint256,uint256,bytes32[]))",
  createGlvDeposit: "createGlvDeposit(((address,address,address,address,address,address,address,address[],address[]),uint256,uint256,uint256,bool,bool,bytes32[]))",
  createGlvWithdrawal: "createGlvWithdrawal(((address,address,address,address,address,address[],address[]),uint256,uint256,bool,uint256,uint256,bytes32[]))",
  getAccountPositions: "getAccountPositions(address,address,uint256,uint256)", getAccountOrders: "getAccountOrders(address,address,uint256,uint256)",
  balanceOf: "balanceOf(address)", allowance: "allowance(address,address)", approve: "approve(address,uint256)", gasPrice: "eth_gasPrice",
});
const SELECTOR = Object.fromEntries(Object.entries(GMX_SIGNATURES).filter(([name]) => name !== "gasPrice").map(([name, signature]) => [name, selectorOf(signature)]));
export const GMX_SELECTORS = Object.freeze({ ...SELECTOR });
const call = (name, types, values) => `${SELECTOR[name]}${encode(types, values)}`;

export const ORDER_TYPE = Object.freeze({ MarketSwap: 0, LimitSwap: 1, MarketIncrease: 2, LimitIncrease: 3, MarketDecrease: 4, LimitDecrease: 5, StopLossDecrease: 6 });
const POSITION_TYPE = { tuple: [{ tuple: ["address", "address", "address"] }, { tuple: ["uint256", "uint256", "uint256", "int256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, { tuple: ["bool"] }] };
const ORDER_PROPS_TYPE = { tuple: ["bytes32", { tuple: [{ tuple: ["address", "address", "address", "address", "address", "address", "address", { array: "address" }] }, { tuple: ["uint8", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, { tuple: ["bool", "bool", "bool", "bool"] }, { array: "bytes32" }] }] };

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
 * @param {{usdcAmount: number, positions: object[], holdingsUsd?: number, nativeUsd?: number}} reading
 */
export function normalizeGmxAccount({ usdcAmount, positions = [], holdingsUsd = 0, nativeUsd = 0, stablecoins = [] } = {}) {
  if (!Number.isFinite(usdcAmount)) throw new TypeError("gmx-usdc-balance-required");
  const stable = new Set(stablecoins.map((a) => a.toLowerCase()));
  const heldPositions = positions.filter((p) => p.sizeUsd > 0).map((p) => ({ market: p.market, side: p.isLong ? "long" : "short", sizeCents: Math.round(p.sizeUsd * 100), collateralToken: p.collateralToken, collateralCents: stable.has(p.collateralToken.toLowerCase()) ? Math.round((Number(p.collateralAmount) / 1e6) * 100) : null }));
  const collateralCents = heldPositions.reduce((sum, p) => sum + (p.collateralCents ?? 0), 0);
  const cashCents = Math.round(usdcAmount * 100);
  return { cashCents, equityCents: cashCents + collateralCents + Math.round(holdingsUsd * 100), freeCashCents: cashCents, gasUsd: nativeUsd, positions: heldPositions };
}

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
export function createGmxAdapter({ chainId = 42161, rpc, fetchJson } = {}) {
  const chain = GMX_CHAINS[chainId];
  if (!chain || typeof rpc !== "function") throw new TypeError("gmx-adapter-configuration-invalid");
  const ethCall = (to, data) => rpc({ method: "eth_call", params: [{ to, data }, "latest"] });
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
    if (token && BigInt(amount) > 0n) calls.push(call("sendTokens", ["address", "address", "uint256"], [token, vault, amount]));
    calls.push(creation);
    return { to: router, value: `0x${BigInt(executionFeeWei).toString(16)}`, data: call("multicall", [{ array: "bytes" }], [calls]) };
  };
  const approvalFor = async (grant, token, amount, spender) => {
    const current = await allowanceOf(token, grant.account, spender);
    return current >= BigInt(amount) ? [] : [{ type: "erc20-approve", token, spender, amount: BigInt(amount).toString(), currentAllowance: current.toString(), transaction: { chainId, from: grant.account, to: token, value: "0x0", data: call("approve", ["address", "uint256"], [spender, amount]) } }];
  };
  const requireFee = (fee) => { if (!(BigInt(fee) > 0n)) throw new RangeError("execution-fee-required"); return BigInt(fee); };

  return Object.freeze({
    chain,
    /** Native gas balance and the stablecoin/collateral token balances named in `tokens`. */
    readAccount: ({ grant, tokens = [chain.usdc, chain.wnt], now }) => read({ grant, scope: "account:read", method: "eth_getBalance+balanceOf", path: `eip155:${chainId}/${grant.account}`, now, operation: { tokens },
      run: async () => ({ account: grant.account, nativeWei: BigInt(await rpc({ method: "eth_getBalance", params: [grant.account, "latest"] })).toString(), tokens: await Promise.all(tokens.map(async (token) => ({ token, raw: (await balanceOf(token, grant.account)).toString() }))) }) }),
    listPositions: ({ grant, now }) => read({ grant, scope: "positions:read", method: "eth_call", path: `${chain.reader}#getAccountPositions`, now,
      run: async () => ({ positions: decodeAccountPositions(await ethCall(chain.reader, call("getAccountPositions", ["address", "address", "uint256", "uint256"], [chain.dataStore, grant.account, 0, 100]))) }) }),
    listOrders: ({ grant, now }) => read({ grant, scope: "orders:read", method: "eth_call", path: `${chain.reader}#getAccountOrders`, now,
      run: async () => ({ orders: decodeAccountOrders(await ethCall(chain.reader, call("getAccountOrders", ["address", "address", "uint256", "uint256"], [chain.dataStore, grant.account, 0, 100]))) }) }),
    /** GMX public REST: market list and oracle tickers, for sizing and mark values. */
    readMarkets: ({ grant, now }) => {
      if (typeof fetchJson !== "function") throw new TypeError("gmx-adapter-fetch-required");
      return read({ grant, scope: "account:read", method: "GET", path: `${chain.api}/markets/info`, now, run: async () => ({ markets: (await fetchJson(`${chain.api}/markets/info`)).markets }) });
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
      const size = BigInt(order.sizeDeltaUsd);
      if (increasing) {
        if (marketDecision && Math.ceil(Number(order.collateralUsd) * 100 - 1e-9) > allocationFor(marketDecision, { venue: 'evm', principal: grant.principal, instrument: order.market, side: order.isLong ? 'long' : 'short', chainId, protocol: 'gmx', at: now })) throw new RangeError('gmx-collateral-exceeds-shared-market-allocation');
        if (!(BigInt(order.collateralAmount) > 0n) || !(Number(order.collateralUsd) > 0)) throw new RangeError("gmx-collateral-required");
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
        [size, increasing ? BigInt(order.collateralAmount) : BigInt(order.collateralAmount ?? 0), BigInt(order.triggerPriceE30 ?? 0), BigInt(order.acceptablePriceE30), fee, 0n, 0n, BigInt(order.validFromTime ?? 0)],
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
      const params = [[grant.account, ZERO, ZERO, deposit.market, deposit.initialLongToken, deposit.initialShortToken, [], []], BigInt(deposit.minMarketTokens ?? 0), false, fee, 0n, []];
      const legs = [[deposit.initialLongToken, deposit.longAmount ?? 0], [deposit.initialShortToken, deposit.shortAmount ?? 0]].filter(([, amount]) => BigInt(amount) > 0n);
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
      const params = [[deposit.glv, deposit.market, grant.account, ZERO, ZERO, deposit.initialLongToken, deposit.initialShortToken, [], []], BigInt(deposit.minGlvTokens ?? 0), fee, 0n, false, false, []];
      const legs = [[deposit.initialLongToken, deposit.longAmount ?? 0], [deposit.initialShortToken, deposit.shortAmount ?? 0]].filter(([, amount]) => BigInt(amount) > 0n);
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
      const params = [[grant.account, ZERO, ZERO, withdrawal.market, withdrawal.glv, [], []], BigInt(withdrawal.minLongTokenAmount ?? 0), BigInt(withdrawal.minShortTokenAmount ?? 0), false, fee, 0n, []];
      if (!(BigInt(withdrawal.glvAmount) > 0n)) throw new RangeError("gmx-withdrawal-amount-required");
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
