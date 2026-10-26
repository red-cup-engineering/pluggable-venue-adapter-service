import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticIdOf} from '@red-cup-engineering/computer-data-engineering-services-section/semiotic-expression-notation/semantic-content-identity';
import {createAlpacaAdapter} from '../src/alpaca-adapter.mjs';
import {createAlpacaBrokerAdministrator} from '../src/alpaca-broker-admin.mjs';
import {createKalshiAdapter} from '../src/kalshi-adapter.mjs';
import {createGmxAdapter, GMX_CHAINS, requiredAllowedContracts} from '../src/gmx-adapter.mjs';

const at = '2026-10-25T12:00:00Z';
const first = '0x1111111111111111111111111111111111111111';
const second = '0x2222222222222222222222222222222222222222';
const market = '0x3333333333333333333333333333333333333333';
const chain = GMX_CHAINS[42161];
const identity = semanticIdOf('brokerage.pluggable-venue-adapter.record');
const grant = (adapter, scopes) => ({type: 'RevocableBrokerageAuthorityGrant',
  id: 'independent:original-grant', adapter, scopes, validUntil: '2027-01-01T00:00:00Z',
  credentialReference: 'independent:credential-reference'});
const response = () => ({status: 200, headers: {}, body: {}, authorityCustodyReceipt: 'independent:receipt'});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const coherent = record => {const {id, ...body} = record; assert.equal(id, identity(body));};
const refuses = action => assert.rejects(async () => action(), /plain-venue-data-required|venue.*data/u);

test('independent: an unsupported time carrier is refused before order transport', async () => {
  let transports = 0;
  const adapter = createAlpacaAdapter({product: 'alpaca-trading-paper',
    baseUrl: 'https://paper-api.alpaca.markets', authorityClient: {
      authorizedRequest: async () => {transports++; return response();},
    }});
  await refuses(() => adapter.placeOrder({grant: grant('alpaca-trading-paper', ['orders:paper']),
    order: {symbol: 'FIXTURE', qty: '1'}, now: new Date(at)}));
  assert.equal(transports, 0, 'failure to retain a receipt must not follow a dispatched order');
});

test('independent: public argument capture rejects getters before URL derivation or destructuring', async () => {
  let getters = 0, transports = 0;
  const adapter = createAlpacaAdapter({product: 'alpaca-broker',
    baseUrl: 'https://broker-api.alpaca.markets', authorityClient: {
      authorizedRequest: async () => {transports++; return response();},
    }});
  const authority = grant('alpaca-broker', ['account:read']);
  Object.defineProperty(authority, 'accountReference', {enumerable: true,
    get() {getters++; return 'fixture-account';}});
  await refuses(() => adapter.readAccount({grant: authority, now: at}));
  const request = {now: at};
  Object.defineProperty(request, 'grant', {enumerable: true, get() {getters++; return authority;}});
  await refuses(() => adapter.readAccount(request));
  assert.equal(getters, 0);
  assert.equal(transports, 0);
});

test('independent: Alpaca validates and retains the same constructor URL', async () => {
  const url = new URL('https://paper-api.alpaca.markets');
  let target;
  const adapter = createAlpacaAdapter({product: 'alpaca-trading-paper', baseUrl: url,
    authorityClient: {authorizedRequest: async request => {target = request.url; return response();}}});
  url.hostname = 'mutated.invalid';
  const receipt = await adapter.readAccount({grant: grant('alpaca-trading-paper', ['account:read']), now: at});
  assert.equal(target, 'https://paper-api.alpaca.markets/v2/account');
  assert.equal(url.hostname, 'mutated.invalid', 'caller configuration remains mutable');
  coherent(receipt);
});

test('independent: Broker administration retains its selected constructor URL', async () => {
  const url = new URL('https://broker-api.alpaca.markets');
  let target;
  const administrator = createAlpacaBrokerAdministrator({baseUrl: url,
    authorityClient: {authorizedRequest: async request => {target = request.url; return response();}}});
  url.hostname = 'mutated.invalid';
  const receipt = await administrator.getAccount({grant: grant('alpaca-broker', ['accounts:read']),
    accountId: 'fixture-account', now: at});
  assert.equal(target, 'https://broker-api.alpaca.markets/v1/accounts/fixture-account');
  coherent(receipt);
});

test('independent: GMX retains an EIP-1898 block selector across the complete account observation', async () => {
  const block = {blockHash: '0x' + 'a'.repeat(64), requireCanonical: true};
  const started = deferred(), resume = deferred(), observed = [];
  const adapter = createGmxAdapter({blockTag: block, rpc: async request => {
    observed.push(request.params.at(-1));
    if (request.method === 'eth_getBalance') {started.resolve(); await resume.promise;}
    return '0x1';
  }});
  const g = {...grant('gmx', ['account:read']), account: first, chainId: 42161};
  const pending = adapter.readAccount({grant: g, tokens: [chain.usdc], now: at});
  await started.promise;
  block.blockHash = '0x' + 'b'.repeat(64); block.requireCanonical = false;
  resume.resolve();
  const receipt = await pending;
  assert.equal(observed.length, 2);
  for (const selector of observed) assert.deepEqual(selector,
    {blockHash: '0x' + 'a'.repeat(64), requireCanonical: true});
  assert.equal(Object.isFrozen(block), false); coherent(receipt);
});

test('independent: both GMX deposit legs retain the same original principal and amounts', async () => {
  const started = deferred(), resume = deferred(); let calls = 0;
  const adapter = createGmxAdapter({rpc: async () => {if (++calls === 2) started.resolve(); await resume.promise; return '0x0';}});
  const g = {...grant('gmx', ['deposits:build']), account: first, chainId: 42161,
    limits: {maxValuePerTransactionUsd: 30,
      allowedContracts: requiredAllowedContracts(42161, {tokens: [chain.usdc, chain.wnt]})}};
  const deposit = {market, initialLongToken: chain.wnt, initialShortToken: chain.usdc,
    longAmount: 100n, shortAmount: 200n,
    minMarketTokens: 0n, valueUsd: 20, executionFeeWei: 1000n};
  const pending = adapter.buildGmDeposit({grant: g, deposit, now: at});
  await started.promise;
  g.account = second; g.id = 'independent:replaced-grant';
  deposit.longAmount = 999n; deposit.shortAmount = 888n;
  resume.resolve();
  const plan = await pending;
  assert.equal(plan.account, first); assert.equal(plan.grant, 'independent:original-grant');
  assert.deepEqual(plan.approvals.map(item => item.amount), ['100', '200']);
  for (const approval of plan.approvals) {
    assert.equal(approval.transaction.from, first);
    assert.throws(() => {approval.transaction.from = second;}, TypeError);
  }
  assert.equal(plan.transactions[0].from, first); coherent(plan);
});

test('independent: replacing a Kalshi request grant while observation is pending refuses placement', async () => {
  const started = deferred(), resume = deferred(); let writes = 0;
  const client = {getBalance: async () => {started.resolve(); await resume.promise; return {balance: 10000, portfolio_value: 0};},
    getPositions: async () => ({market_positions: []}), getOrders: async () => [], getFills: async () => [],
    createOrder: async () => {writes++; return {};}, cancelOrder: async () => ({})};
  const contract = {type: 'PrincipalBrokerageServiceContract', id: 'independent:contract',
    capital: {amount: 100, currency: 'USD'}, risk: {maximumLossAmount: 100,
      maximumOrderNotional: 10, maximumAggregateNotional: 50, concentrationLimit: 1}};
  const request = {grant: {...grant('kalshi', ['orders:live']), principalContract: contract.id}, contract,
    order: {ticker: 'FIXTURE-EVENT-MARKET', side: 'bid', price: '0.50', count: '1', clientOrderId: 'independent-order'}, now: at};
  const pending = createKalshiAdapter({client}).placeOrder(request);
  await started.promise;
  request.grant = {...request.grant, revoked: true}; resume.resolve();
  await assert.rejects(pending, /authority-or-contract-changed/u);
  assert.equal(writes, 0);
});

test('independent: shared acyclic request values remain shared, copied and frozen', async () => {
  const member = {venueTag: 'original'}, order = {symbol: 'FIXTURE', qty: '1', first: member, second: member};
  let received;
  const adapter = createAlpacaAdapter({product: 'alpaca-trading-paper', baseUrl: 'https://paper-api.alpaca.markets',
    authorityClient: {authorizedRequest: async request => {received = request.body; return response();}}});
  const receipt = await adapter.placeOrder({grant: grant('alpaca-trading-paper', ['orders:paper']), order, now: at});
  assert.equal(received.first, received.second);
  assert.notEqual(received.first, member);
  assert.throws(() => {received.first.venueTag = 'changed';}, TypeError);
  member.venueTag = 'caller-changed'; assert.equal(received.first.venueTag, 'original');
  coherent(receipt);
});
