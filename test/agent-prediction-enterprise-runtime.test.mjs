import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {offerAgentOrder} from '../src/agent-prediction-x402-v2.mjs';
import {createAgentPredictionEnterpriseRuntime}
  from '../src/agent-prediction-enterprise-runtime.mjs';
const A=c=>'0x'+c.repeat(40),N=c=>'0x'+c.repeat(64),S=c=>'0x'+c.repeat(130);
const market=A('c'),asset=A('e'),buyer=A('b'),sponsor=A('f'),network='eip155:84532';
const now=()=>Math.floor(Date.now()/1000),gasLimit=250000n,gasFee=10000000000n;
const quoteSource={marketAddress:market,expectedAsset:asset,expectedNetwork:network,
  expectedMarketCodeHash:N('8'),expectedAssetCodeHash:N('9'),expectedRulesDigest:N('a')};
function quote({resource,marketId,askId,lots}){
 const t=now();return offerAgentOrder({resource,requirement:{
  scheme:'561-agent-prediction-order-v1',network,asset,payTo:market,amount:'1111000',maxTimeoutSeconds:45,
  extra:{paymentFlow:'upfront',assetTransferMethod:'eip3009-receive',name:'Synthetic x402 Collateral',
   version:'2',marketId,askId,lots,outcome:0,unitPrice:'550000',makerAmount:'1100000',
   tradeFee:'11000',providerFee:'4400',protocolFee:'6600',provider:A('1'),maker:A('2'),
   protocolRecipient:A('3'),quoteBlock:'125',quoteBlockHash:N('8'),expiresAt:String(t+60),
   buyIntentEip712Domain:{name:'561 Agent Prediction Market PoC',version:'1'}}}});
}
const paySignature=required=>{
 const data=JSON.parse(Buffer.from(required,'base64'));const t=now();
 return Buffer.from(JSON.stringify({x402Version:2,resource:data.resource,accepted:data.accepts[0],payload:{
  buyIntent:{buyer,askId:'42',lots:'2',maxTotal:'1111000',deadline:String(t+30),nonce:N('4'),paymentNonce:N('5')},
  buySignature:S('a'),authorization:{from:buyer,to:market,value:'1111000',
   validAfter:String(t-1),validBefore:String(t+40),nonce:N('5'),signature:S('b')}
 }})).toString('base64');
};
function configuration(){
 const quoteProvider={getNetwork:async()=>({chainId:84532n}),
   getBlockNumber:async()=>125};
 let signed=0,custodyCalls=0,received=0;
 const sponsorProvider={getNetwork:async()=>({chainId:84532n}),getBlockNumber:async()=>125,
   getCode:async address=>address===market?'0x60016000':address===asset?'0x60026000':'0x',
   call:async args=>{assert.equal(args.to,market);return '0x';}};
 const body='0x1122334455667788';
 const config={publicOrigin:'https://market.example',quoteProvider,quoteSource,readMarketQuote:quote,
   activated:true,buyerMandate:async()=>true,sponsorProvider,
   sponsorPolicy:{network,marketAddress:market,assetAddress:asset,marketCodeHash:N('8'),assetCodeHash:N('9'),
    sponsorAddress:sponsor,maxGasLimit:gasLimit,maxFeePerGasWei:gasFee,maxGasCostWei:gasLimit*gasFee},
   custody:{execute:async({executionId,prepareSigned})=>{
    custodyCalls++;await prepareSigned();return {status:'reconciled',disposition:'succeeded',executionId,transactionHash:N('6')};
   },reconcile:async()=>({status:'no-pending-transaction'})},
   prepareSignedFill:async()=>{signed++;return {serializedTransaction:'0xdeadbeef',
     evidence:{type:'AuthorizedMockSignedMarketCall'},expiresAt:new Date(Date.now()+20000).toISOString()};},
   readMarketReceipt:async()=>{received++;return {finalized:true,transactionStatus:1,network,
     transactionHash:N('6'),market,asset,buyer,marketId:'12',askId:'42',lots:'2',outcome:0,
     paymentNonce:N('5'),buyNonce:N('4'),amount:'1111000',maker:A('2'),provider:A('1'),
     protocolRecipient:A('3'),makerAmount:'1100000',providerFee:'4400',protocolFee:'6600',
     sourceEconomicEvent:{type:'EvmAgentPredictionAskFilled',chain:network,
       blockNumber:125,blockHash:N('8'),transactionHash:N('6'),logIndex:6,
       emitter:market,event:'AskFilled'},
     authorizationNonceConsumed:true,buyerDebited:true,sharesReceived:true,
     feesSettled:true,backingConserved:true};},
   implementation:{ethers:{},encodeMarketCall:()=>body,
     hashCode:c=>c==='0x60016000'?N('8'):N('9'),verifyTypedData:()=>buyer,
     decodeSignedTransaction:()=>({from:sponsor,to:market,chainId:84532n,data:body,
       value:0n,type:2,gasLimit,maxFeePerGas:gasFee})},
 };
 return {config,getMetrics:()=>({signed,custodyCalls,received})};
}
const buyBody=JSON.stringify({lots:'2'});
const req=(method,headers={})=>new Request('https://market.example/market/12/asks/42/buy',{
 method,headers,...(method==='POST'?{body:buyBody}:{})});

test('source-owned enterprise boots READ ONLY if no execution services were authorized',async()=>{
 const {config}=configuration();const runtime=createAgentPredictionEnterpriseRuntime({
  publicOrigin:config.publicOrigin,quoteProvider:config.quoteProvider,quoteSource,
  readMarketQuote:quote,activated:false});
 assert.equal(runtime.active,false);
 const response=await runtime.fetch(new Request('https://market.example/market/12/asks/42/quote?lots=2'));
 assert.equal(response.status,200);
 assert.equal((await response.json()).quote.amount,'1111000');
 assert.equal((await runtime.fetch(req('POST'))).status,503);
 assert.equal((await runtime.reconcile()).status,'read-only-no-transactions');
});

test('source-owned enterprise composes signed market fill across a genuine HTTP listener',async()=>{
 const {config,getMetrics}=configuration();const runtime=createAgentPredictionEnterpriseRuntime(config);
 const listener=createServer(async(incoming,outgoing)=>{
  try{
   const body=[];for await(const part of incoming)body.push(part);
   const request=new Request('https://market.example'+incoming.url,{method:incoming.method,
    headers:incoming.headers,...(body.length?{body:Buffer.concat(body)}:{})});
   const result=await runtime.fetch(request);
   outgoing.writeHead(result.status,Object.fromEntries(result.headers));
   outgoing.end(Buffer.from(await result.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end();}
 });
 listener.listen(0,'127.0.0.1');await once(listener,'listening');
 try{
  const target='http://127.0.0.1:'+listener.address().port+'/market/12/asks/42/buy';
  const unpaid=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body:buyBody});
  assert.equal(unpaid.status,402);
  const paymentSignature=paySignature(unpaid.headers.get('PAYMENT-REQUIRED'));
  const paid=await fetch(target,{method:'POST',headers:{'content-type':'application/json',
    'payment-signature':paymentSignature},body:buyBody});
  assert.equal(paid.status,200);
  const head=JSON.parse(Buffer.from(paid.headers.get('PAYMENT-RESPONSE'),'base64'));
  assert.equal(head.success,true);assert.equal(head.network,network);
  const receipt=await paid.json();
  assert.equal(receipt.status,'filled');assert.equal(receipt.transactionHash,N('6'));
  assert.equal(receipt.sourceEconomicEvent.logIndex,6);
  assert.deepEqual(getMetrics(),{signed:1,custodyCalls:1,received:1});
 }finally{listener.close();await once(listener,'close');}
});

test('misaligned economic source and sponsor boundaries refuse to activate',()=>{
 const {config}=configuration();
 assert.throws(()=>createAgentPredictionEnterpriseRuntime({
   ...config,sponsorPolicy:{...config.sponsorPolicy,assetAddress:A('1')}}),
   /quotation contract and authorized sponsor/u);
 assert.throws(()=>createAgentPredictionEnterpriseRuntime({
   ...config,custody:undefined}),/requires explicit/u);
});
