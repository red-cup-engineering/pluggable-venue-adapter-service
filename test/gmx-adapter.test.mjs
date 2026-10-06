import assert from "node:assert/strict";
import test from "node:test";
import { GMX_CHAINS, GMX_SELECTORS, ORDER_TYPE, createGmxAdapter, decodeAccountOrders, decodeAccountPositions, encode, keccak256, normalizeGmxAccount, requiredAllowedContracts, selectorOf, usdToE30 } from "../src/gmx-adapter.mjs";

const now = "2026-10-03T12:00:00Z";
const C = GMX_CHAINS[42161];
const ACCOUNT = "0x224C08A8526751887a83e2711B167f890c6D078d";
const BTC_GM = "0x47c031236e19d024b42f8AE6780E44A573170703";
const GLV_BTC = "0xdF03EEd325b82bC1d4Db8b49c30ecc9E05104b96";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const ZERO = "0x0000000000000000000000000000000000000000";
const grant = (overrides = {}) => ({ type: "RevocableBrokerageAuthorityGrant", id: "urn:grant:gmx-fixture", adapter: "gmx", chainId: 42161, account: ACCOUNT, validUntil: "2027-01-01T00:00:00Z",
  scopes: ["account:read", "positions:read", "orders:read", "orders:build", "deposits:build"], credentialReference: "key-management:base/yanagi-wallet",
  limits: { maxValuePerTransactionUsd: 25, maxLossPerUtcDayUsd: 50, maxLeverage: 3, allowedContracts: requiredAllowedContracts(42161, { tokens: [C.usdc, GLV_BTC] }) }, ...overrides });
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
function fakeRpc({ allowance = 0n, balances = {}, native = 142180363081415n, positions = `0x${word(32)}${word(0)}`, orders = `0x${word(32)}${word(0)}` } = {}) {
  const calls = [];
  const rpc = async ({ method, params }) => {
    calls.push({ method, params });
    if (method === "eth_getBalance") return `0x${native.toString(16)}`;
    const [{ to, data }] = params;
    if (data.startsWith(GMX_SELECTORS.balanceOf)) return `0x${word(balances[to.toLowerCase()] ?? 0n)}`;
    if (data.startsWith(GMX_SELECTORS.allowance)) return `0x${word(allowance)}`;
    if (data.startsWith(GMX_SELECTORS.getAccountPositions)) return positions;
    if (data.startsWith(GMX_SELECTORS.getAccountOrders)) return orders;
    throw new Error(`unexpected call ${method}`);
  };
  return { rpc, calls };
}
const order = (overrides = {}) => ({ market: BTC_GM, collateralToken: C.usdc, collateralAmount: 10_000_000n, collateralUsd: 10, sizeDeltaUsd: usdToE30(20), isLong: true, acceptablePriceE30: 90000n * 10n ** 26n, executionFeeWei: 230_000_000_000_000n, ...overrides });

test("keccak256 and selectors match the published vectors", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(selectorOf("balanceOf(address)"), "0x70a08231");
  // pinned against viem's toFunctionSelector for the verified ExchangeRouter / GlvRouter / SyntheticsReader ABIs (2026-10-03)
  assert.deepEqual({ multicall: GMX_SELECTORS.multicall, sendWnt: GMX_SELECTORS.sendWnt, sendTokens: GMX_SELECTORS.sendTokens, createOrder: GMX_SELECTORS.createOrder, createDeposit: GMX_SELECTORS.createDeposit, createGlvDeposit: GMX_SELECTORS.createGlvDeposit, createGlvWithdrawal: GMX_SELECTORS.createGlvWithdrawal, getAccountPositions: GMX_SELECTORS.getAccountPositions, getAccountOrders: GMX_SELECTORS.getAccountOrders },
    { multicall: "0xac9650d8", sendWnt: "0x7d39aaf1", sendTokens: "0xe6d66ac8", createOrder: "0xf59c48eb", createDeposit: "0xc82aa41b", createGlvDeposit: "0xdfa05241", createGlvWithdrawal: "0x7c6fa43b", getAccountPositions: "0x77cfb162", getAccountOrders: "0x42a6f8d3" });
});

test("reads: account, positions and orders are admitted, decoded, frozen and carry no signature", async () => {
  const position = encode([{ array: { tuple: [{ tuple: ["address", "address", "address"] }, { tuple: ["uint256", "uint256", "uint256", "int256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"] }, { tuple: ["bool"] }] } }],
    [[[[ACCOUNT, BTC_GM, C.usdc], [usdToE30(20), 23000n, 10_000_000n, -5n, 7n, 1n, 2n, 3n, 1790000000n, 0n], [true]]]]);
  const { rpc, calls } = fakeRpc({ balances: { [C.usdc.toLowerCase()]: 3_550_000n }, positions: `0x${position}` });
  const adapter = createGmxAdapter({ chainId: 42161, rpc });
  const account = await adapter.readAccount({ grant: grant(), now });
  const positions = await adapter.listPositions({ grant: grant(), now });
  const orders = await adapter.listOrders({ grant: grant(), now });
  for (const receipt of [account, positions, orders]) { assert.equal(receipt.type, "GmxVenueOperationReceipt"); assert.equal(receipt.outcome, "accepted"); assert.equal(receipt.signed, false); assert.equal(receipt.credentialsExported, false); assert.ok(Object.isFrozen(receipt)); assert.match(receipt.id, /\S/); }
  assert.equal(account.payload.nativeWei, "142180363081415");
  assert.deepEqual(account.payload.tokens.map((t) => [t.token, t.raw]), [[C.usdc, "3550000"], [C.wnt, "0"]]);
  assert.equal(positions.payload.positions.length, 1);
  assert.equal(positions.payload.positions[0].sizeUsd, 20);
  assert.equal(positions.payload.positions[0].isLong, true);
  assert.equal(positions.payload.positions[0].pendingImpactAmount, "-5");
  assert.deepEqual(orders.payload, { orders: [] });
  assert.ok(calls.every((call) => call.method === "eth_call" || call.method === "eth_getBalance"), "reads use only eth_call and eth_getBalance");
  for (const forbidden of ["sign", "send", "placeOrder", "broadcast", "sendTransaction"]) assert.equal(adapter[forbidden], undefined);
  assert.deepEqual(decodeAccountPositions(`0x${encode([{ array: "uint256" }], [[]])}`), []);
  assert.deepEqual(decodeAccountOrders(`0x${encode([{ array: "uint256" }], [[]])}`), []);
});

test("normalizeGmxAccount: equity is USDC cash plus stable collateral plus holdings, gas ETH excluded", () => {
  const account = normalizeGmxAccount({ usdcAmount: 3.55, holdingsUsd: 21.74, nativeUsd: 0.38, stablecoins: [C.usdc], positions: [{ market: BTC_GM, isLong: true, sizeUsd: 20, collateralToken: C.usdc, collateralAmount: 10_000_000n }] });
  assert.equal(account.cashCents, 355);
  assert.equal(account.equityCents, 355 + 1000 + 2174);
  assert.equal(account.freeCashCents, 355);
  assert.deepEqual(account.positions, [{ market: BTC_GM, side: "long", sizeCents: 2000, collateralToken: C.usdc, collateralCents: 1000 }]);
  assert.throws(() => normalizeGmxAccount({}), /gmx-usdc-balance-required/);
});

test("buildPerpOrder returns an unsigned multicall(sendWnt, sendTokens, createOrder) plus the Router approval", async () => {
  const { rpc } = fakeRpc({ allowance: 0n });
  const plan = await createGmxAdapter({ chainId: 42161, rpc }).buildPerpOrder({ grant: grant(), order: order(), now });
  assert.equal(plan.type, "GmxUnsignedTransactionPlan");
  assert.equal(plan.signed, false); assert.equal(plan.broadcast, false); assert.equal(plan.credentialsExported, false);
  assert.ok(Object.isFrozen(plan));
  assert.equal(plan.transactions.length, 1);
  const [tx] = plan.transactions;
  assert.equal(tx.to, C.exchangeRouter); assert.equal(tx.from, ACCOUNT); assert.equal(tx.chainId, 42161);
  assert.equal(BigInt(tx.value), 230_000_000_000_000n);
  assert.ok(tx.data.startsWith(GMX_SELECTORS.multicall));
  // golden: byte-identical to viem.encodeFunctionData(multicall[sendWnt, sendTokens, createOrder]) with the verified ABI (2026-10-03)
  assert.equal(keccak256(Uint8Array.from(Buffer.from(tx.data.slice(2), "hex"))), "0x20429659c6af986a2ff3285f40696adc449712bcb250efbfbb65924709352007");
  assert.equal(plan.approvals.length, 1);
  assert.equal(plan.approvals[0].spender, C.router);
  assert.equal(plan.approvals[0].transaction.data, `0x095ea7b3${C.router.slice(2).toLowerCase().padStart(64, "0")}${word(10_000_000n)}`);
  assert.equal(plan.valueUsd, 10);
  // an existing allowance removes the approval step
  const covered = await createGmxAdapter({ chainId: 42161, rpc: fakeRpc({ allowance: 10_000_000n }).rpc }).buildPerpOrder({ grant: grant(), order: order(), now });
  assert.deepEqual(covered.approvals, []);
});

test("buildGlvDeposit and buildGlvWithdrawal target the GlvRouter and its vault", async () => {
  const { rpc } = fakeRpc();
  const adapter = createGmxAdapter({ chainId: 42161, rpc });
  const deposit = await adapter.buildGlvDeposit({ grant: grant(), now, deposit: { glv: GLV_BTC, market: BTC_GM, initialLongToken: WBTC, initialShortToken: C.usdc, shortAmount: 10_000_000n, valueUsd: 10, minGlvTokens: 1n, executionFeeWei: 230_000_000_000_000n } });
  assert.equal(deposit.transactions[0].to, C.glvRouter);
  assert.equal(keccak256(Uint8Array.from(Buffer.from(deposit.transactions[0].data.slice(2), "hex"))), "0x95860c67ca6e8c3b5c39fafa5ac2c537df1ffffd14871bc06f68a21d10e022f7");
  assert.equal(deposit.kind, "glv-deposit");
  const withdrawal = await adapter.buildGlvWithdrawal({ grant: grant(), now, withdrawal: { glv: GLV_BTC, market: BTC_GM, glvAmount: 9_116_172_534_368_098_201n, valueUsd: 14.4, executionFeeWei: 230_000_000_000_000n } });
  assert.equal(withdrawal.transactions[0].to, C.glvRouter);
  assert.equal(withdrawal.approvals[0].token, GLV_BTC);
  const gm = await adapter.buildGmDeposit({ grant: grant(), now, deposit: { market: BTC_GM, initialLongToken: WBTC, initialShortToken: C.usdc, shortAmount: 5_000_000n, valueUsd: 5, executionFeeWei: 230_000_000_000_000n } });
  assert.equal(gm.transactions[0].to, C.exchangeRouter);
});

test("admission: wrong adapter, chain, scope, expiry, revocation and credential fields are refused before any call", async () => {
  const { rpc, calls } = fakeRpc();
  const adapter = createGmxAdapter({ chainId: 42161, rpc });
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ adapter: "kalshi" }), order: order(), now }), /gmx-authority-required/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ chainId: 8453 }), order: order(), now }), /grant-chain-mismatch/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ scopes: ["account:read"] }), order: order(), now }), /venue-operation-scope-refused/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ validUntil: "2026-10-01T00:00:00Z" }), order: order(), now }), /authority-expired/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ revoked: true }), order: order(), now }), /current-authority-grant-required/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant(), order: order({ privateKey: "0xdead" }), now }), /credential-bearing-venue-request-refused/);
  await assert.rejects(Promise.resolve().then(() => adapter.listPositions({ grant: grant({ scopes: [] }), now })), /venue-operation-scope-refused/);
  assert.equal(calls.length, 0, "refusals happen before the network is touched");
});

test("limits: per-transaction value, leverage, allowed contracts and the loss-free default all fail closed", async () => {
  const adapter = createGmxAdapter({ chainId: 42161, rpc: fakeRpc().rpc });
  await assert.rejects(adapter.buildPerpOrder({ grant: grant(), order: order({ collateralAmount: 26_000_000n, collateralUsd: 26, sizeDeltaUsd: usdToE30(26) }), now }), /order-value-exceeds-grant-limit/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant(), order: order({ sizeDeltaUsd: usdToE30(31) }), now }), /order-leverage-exceeds-grant-limit/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ limits: { maxValuePerTransactionUsd: 25, maxLeverage: 3, allowedContracts: [] } }), order: order(), now }), /contract-not-allowed-by-grant/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ limits: { maxLeverage: 3, allowedContracts: requiredAllowedContracts(42161, { tokens: [C.usdc] }) } }), order: order(), now }), /grant-value-limit-required/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ limits: { maxValuePerTransactionUsd: 25, allowedContracts: requiredAllowedContracts(42161, { tokens: [C.usdc] }) } }), order: order(), now }), /grant-leverage-limit-required/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant(), order: order({ executionFeeWei: 0n }), now }), /execution-fee-required/);
  await assert.rejects(adapter.buildPerpOrder({ grant: grant(), order: order({ orderType: ORDER_TYPE.MarketSwap }), now }), /gmx-order-type-unsupported/);
  // approving a token the grant does not name is refused even when the routers are named
  await assert.rejects(adapter.buildPerpOrder({ grant: grant({ limits: { maxValuePerTransactionUsd: 25, maxLeverage: 3, allowedContracts: requiredAllowedContracts(42161) } }), order: order(), now }), /contract-not-allowed-by-grant/);
});

test("configuration: unsupported chain or missing rpc is refused", () => {
  assert.throws(() => createGmxAdapter({ chainId: 8453, rpc: async () => "0x" }), /gmx-adapter-configuration-invalid/);
  assert.throws(() => createGmxAdapter({ chainId: 42161 }), /gmx-adapter-configuration-invalid/);
});
