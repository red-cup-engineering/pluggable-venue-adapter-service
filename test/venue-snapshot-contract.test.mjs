import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticIdOf } from '@red-cup-engineering/computer-data-engineering-services-section/semiotic-expression-notation/semantic-content-identity';
import { createAlpacaAdapter } from '../src/alpaca-adapter.mjs';
import { createAlpacaBrokerAdministrator } from '../src/alpaca-broker-admin.mjs';
import { createKalshiAdapter } from '../src/kalshi-adapter.mjs';
import { createGmxAdapter, GMX_CHAINS, GMX_SELECTORS, requiredAllowedContracts, usdToE30 } from '../src/gmx-adapter.mjs';

const now = '2026-10-25T12:00:00Z';
const later = '2027-01-01T00:00:00Z';
const first = '0x1111111111111111111111111111111111111111';
const second = '0x2222222222222222222222222222222222222222';
const market = '0x3333333333333333333333333333333333333333';
const chain = GMX_CHAINS[42161];
const identity = semanticIdOf('brokerage.pluggable-venue-adapter.record');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const intact = value => { const {id, ...body} = value; assert.equal(identity(body), id); };
const grant = (adapter, scopes) => ({type:'RevocableBrokerageAuthorityGrant', id:'urn:grant:original', adapter, validUntil:later, scopes, credentialReference:'urn:credential:reference'});
const gmxGrant = () => ({...grant('gmx',['account:read','orders:build','deposits:build']), chainId:42161, account:first, limits:{maxValuePerTransactionUsd:25, maxLeverage:3, allowedContracts:requiredAllowedContracts(42161,{tokens:[chain.usdc]})}});
const gmxOrder = () => ({market, collateralToken:chain.usdc, collateralAmount:10_000_000n, collateralUsd:10, sizeDeltaUsd:usdToE30(20), isLong:true, acceptablePriceE30:90_000n*10n**26n, executionFeeWei:230_000_000_000_000n});
const alpacaResponse = body => ({status:200, headers:{'x-request-id':'fixture'}, body, authorityCustodyReceipt:'urn:custody:receipt'});
const makeAlpaca = (authorizedRequest, recordReceipt) => createAlpacaAdapter({product:'alpaca-trading-paper', baseUrl:'https://paper-api.alpaca.markets', authorityClient:{authorizedRequest}, recordReceipt});
const contract = () => ({type:'PrincipalBrokerageServiceContract',id:'urn:contract:original', capital:{amount:100,currency:'USD'},risk:{maximumLossAmount:100,maximumOrderNotional:50,maximumAggregateNotional:100,concentrationLimit:1}});
const kalshiGrant = () => ({...grant('kalshi',['account:read','positions:read','orders:read','orders:live']),principalContract:'urn:contract:original'});
const kalshiClient = (overrides={}) => ({getBalance:async()=>({balance:10_000,portfolio_value:0}),getPositions:async()=>({market_positions:[]}),getOrders:async()=>[],getFills:async()=>[],createOrder:async order=>({order}),cancelOrder:async()=>({}),...overrides});

test('Alpaca retains the request authority even when its caller changes the grant during transport', async()=>{
 const began=deferred(), finish=deferred(), g=grant('alpaca-trading-paper',['account:read']);
 let requested;
 const promise=makeAlpaca(async request=>{requested=request;began.resolve();await finish.promise;return alpacaResponse({account:{cash:'12.00'}});}).readAccount({grant:g,now});
 await began.promise;g.id='urn:grant:changed';finish.resolve();
 const receipt=await promise;
 assert.equal(receipt.grant,requested.authorityGrantReference);
 assert.equal(receipt.grant,'urn:grant:original');intact(receipt);
 assert.equal(Object.isFrozen(g),false);
});

test('Alpaca retained receipts cannot be changed by a recording callback or their response supplier',async()=>{
 const body={positions:[{qty:'1',asset:{symbol:'TEST'}}]};let received;
 const receipt=await makeAlpaca(async()=>alpacaResponse(body),value=>{
  received=value;assert.throws(()=>{value.payload.positions[0].qty='900';},TypeError);
 }).readAccount({grant:grant('alpaca-trading-paper',['account:read']),now});
 body.positions[0].asset.symbol='CHANGED';
 assert.equal(receipt,received);assert.equal(receipt.payload.positions[0].asset.symbol,'TEST');intact(receipt);
 assert.equal(Object.isFrozen(body.positions),false);
});

test('GMX account observations keep one account and declared token population across awaits',async()=>{
 const began=deferred(), finish=deferred(), g=gmxGrant(), tokens=[chain.usdc], requests=[];
 const adapter=createGmxAdapter({rpc:async request=>{
  requests.push(request);
  if(request.method==='eth_getBalance'){began.resolve();await finish.promise;return '0x64';}
  return '0x01';
 }});
 const pending=adapter.readAccount({grant:g,tokens,now});await began.promise;
 g.account=second;g.id='urn:grant:changed';tokens.push(chain.wnt);finish.resolve();
 const receipt=await pending;
 assert.equal(receipt.grant,'urn:grant:original');assert.equal(receipt.payload.account,first);
 assert.equal(receipt.payload.tokens.length,1);
 assert.equal(requests.filter(r=>r.method==='eth_call').length,1);
 assert.ok(requests[1].params[0].data.endsWith(first.slice(2).padStart(64,'0')));
 assert.equal(Object.isFrozen(tokens),false);intact(receipt);
});

test('GMX approval, transaction and retained plan describe one invocation while allowance is pending',async()=>{
 const began=deferred(),finish=deferred(),g=gmxGrant(),order=gmxOrder();
 const adapter=createGmxAdapter({rpc:async request=>{assert.ok(request.params[0].data.startsWith(GMX_SELECTORS.allowance));began.resolve();await finish.promise;return '0x00';}});
 const pending=adapter.buildPerpOrder({grant:g,order,now});await began.promise;
 g.account=second;g.id='urn:grant:changed';order.collateralAmount=1n;finish.resolve();
 const plan=await pending;
 assert.equal(plan.account,first);assert.equal(plan.grant,'urn:grant:original');
 assert.equal(plan.transactions[0].from,first);assert.equal(plan.approvals[0].transaction.from,first);
 assert.equal(plan.approvals[0].amount,'10000000');assert.equal(Object.isFrozen(g.limits),false);intact(plan);
});

test('GMX unsigned plan transactions and approvals stay immutable after identification',async()=>{
 const plan=await createGmxAdapter({rpc:async()=> '0x00'}).buildPerpOrder({grant:gmxGrant(),order:gmxOrder(),now});
 assert.throws(()=>{plan.transactions[0].to=second;},TypeError);
 assert.throws(()=>{plan.approvals[0].transaction.data='0x';},TypeError);
 assert.throws(()=>plan.transactions.push({}),TypeError);intact(plan);
});

test('Kalshi captures the submitted order before asynchronous account observation',async()=>{
 const began=deferred(),finish=deferred(),g=kalshiGrant(),c=contract(),order={ticker:'EVENT-1-A',side:'bid',count:'1',price:'0.50',clientOrderId:'original'};let submitted;
 const adapter=createKalshiAdapter({client:kalshiClient({getBalance:async()=>{began.resolve();await finish.promise;return {balance:10_000,portfolio_value:0};},createOrder:async value=>{submitted=value;return {order_id:'fixture',received:value};}})});
 const pending=adapter.placeOrder({grant:g,contract:c,order,now});await began.promise;
 order.count='2';order.clientOrderId='changed';finish.resolve();
 const receipt=await pending;
 assert.equal(submitted.count,'1');assert.equal(submitted.clientOrderId,'original');
 assert.throws(()=>{receipt.payload.received.count='3';},TypeError);intact(receipt);
 assert.equal(Object.isFrozen(order),false);
});

test('Kalshi still refuses authority revocation or principal policy drift before placement',async()=>{
 for(const change of ['grant','contract']){
  const began=deferred(),finish=deferred(),g=kalshiGrant(),c=contract();let writes=0;
  const adapter=createKalshiAdapter({client:kalshiClient({getBalance:async()=>{began.resolve();await finish.promise;return {balance:10_000,portfolio_value:0};},createOrder:async()=>{writes++;return {};}})});
  const pending=adapter.placeOrder({grant:g,contract:c,order:{ticker:'EVENT-1-A',side:'bid',count:1,price:.5,clientOrderId:'drift'},now});
  await began.promise;if(change==='grant')g.revoked=true;else c.risk.maximumOrderNotional=40;finish.resolve();
  await assert.rejects(pending,/authority|policy|contract.*changed/);assert.equal(writes,0);
 }
});

test('Broker administration requires finite times before dispatch and retains immutable response data',async()=>{
 let calls=0;const body={account:{id:'fixture'}};
 const administrator=createAlpacaBrokerAdministrator({authorityClient:{authorizedRequest:async()=>{calls++;return alpacaResponse(body);}}});
 const g=grant('alpaca-broker',['accounts:read']);
 for(const value of [{now:'invalid'}, {grant:{...g,validUntil:'invalid'}}]){
  await assert.rejects(administrator.getAccount({grant:g,accountId:'fixture',now,...value}),/time|scope/);
 }
 assert.equal(calls,0);
 const receipt=await administrator.getAccount({grant:g,accountId:'fixture',now});body.account.id='changed';
 assert.equal(receipt.payload.account.id,'fixture');assert.throws(()=>{receipt.payload.account.id='no';},TypeError);intact(receipt);
 assert.equal(Object.isFrozen(body.account),false);
});

test('optional undefined inputs and BigInt calldata preserve existing admitted behavior',async()=>{
 const plan=await createGmxAdapter({rpc:async()=> '0x00'}).buildPerpOrder({grant:gmxGrant(),order:{...gmxOrder(),swapPath:undefined},marketDecision:undefined,now});
 assert.equal(plan.approvals[0].amount,'10000000');intact(plan);
 const receipt=await makeAlpaca(async request=>{assert.equal(request.body,undefined);return alpacaResponse({cash:'0.00'});}).readAccount({grant:grant('alpaca-trading-paper',['account:read']),observationAuthorization:undefined,now});
 assert.equal(receipt.payload.cash,'0.00');intact(receipt);
});

test('non-data request containers are refused before effects rather than silently cloned into records',async()=>{
 let calls=0;const adapter=makeAlpaca(async()=>{calls++;return alpacaResponse({});});
 class Application {constructor(){this.symbol='TEST';this.qty='1';}}
 for(const order of [new Application(),new Map([['symbol','TEST']]),{symbol:'TEST',metadata:new Date(now)}]){
  await assert.rejects(async()=>adapter.placeOrder({grant:grant('alpaca-trading-paper',['orders:paper']),order,now}),/venue.*data|plain.*data/);
 }
 assert.equal(calls,0);
});
