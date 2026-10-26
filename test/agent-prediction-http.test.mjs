import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { offerAgentOrder } from '../src/agent-prediction-x402-v2.mjs';
import { createAgentPredictionOrderHttpHandler } from '../src/agent-prediction-http.mjs';

const A = c => '0x' + c.repeat(40);
const N = c => '0x' + c.repeat(64);
const SIG = c => '0x' + c.repeat(130);
const current = () => Math.floor(Date.now() / 1000);
const origin = 'https://market.example';
const route = '/market/12/asks/42';
function quote({resource}) {
  const nowSeconds = current();
  return offerAgentOrder({resource,nowSeconds,requirement:{
    scheme:'561-agent-prediction-order-v1', network:'eip155:84532',
    amount:'1111000', asset:A('e'), payTo:A('c'), maxTimeoutSeconds:45,
    extra:{paymentFlow:'upfront',assetTransferMethod:'eip3009-receive',
      name:'Synthetic x402 Collateral',version:'2',marketId:'12',askId:'42',lots:'2',
      outcome:0,unitPrice:'550000',makerAmount:'1100000',tradeFee:'11000',
      providerFee:'4400',protocolFee:'6600',provider:A('1'),maker:A('2'),protocolRecipient:A('3'),
      quoteBlock:'125',quoteBlockHash:N('8'),expiresAt:String(nowSeconds+60),
      buyIntentEip712Domain:{name:'561 Agent Prediction Market PoC',version:'1'}
    }
  }});
}
function create(options={}) {
  return createAgentPredictionOrderHttpHandler({
    origin,quoteInputs:{marketAddress:A('c')},quoteMarket:quote,...options,
  });
}
function paymentHeader(challenge) {
  const c=JSON.parse(Buffer.from(challenge.headers['PAYMENT-REQUIRED'],'base64'));
  const t=current();
  const p={x402Version:2,resource:c.resource,accepted:c.accepts[0],payload:{
    buyIntent:{buyer:A('b'),askId:'42',lots:'2',maxTotal:'1111000',
      deadline:String(t+30),nonce:N('4'),paymentNonce:N('5')},
    buySignature:SIG('a'),authorization:{from:A('b'),to:A('c'),value:'1111000',
      validAfter:String(t-1),validBefore:String(t+40),nonce:N('5'),signature:SIG('f')}
  }};
  return Buffer.from(JSON.stringify(p)).toString('base64');
}
const get = path => new Request(origin+path);
const post = (path,headers={},body={lots:'2'}) =>
  new Request(origin+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('inactive market serves a genuinely read-only quote, never an actionable payment challenge',async()=>{
  const handle=create();
  const response=await handle(get(route+'/quote?lots=2'));
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.status,'read_only_quote');
  assert.equal(result.payable,false);
  assert.equal(result.quote.amount,'1111000');
  assert.equal(result.quote.extra.provider,A('1'));
  assert.equal(response.headers.get('payment-required'),null);
  assert.equal((await handle(post(route+'/buy'))).status,503);
  assert.equal((await handle(post(route+'/buy',{'payment-signature':'forged'}))).status,503);
});

test('a quoted market, order and lots must agree with the actual requested URI',async()=>{
  const handle=create();
  assert.equal((await handle(get('/market/13/asks/42/quote?lots=2'))).status,503);
  assert.equal((await handle(get(route+'/quote?lots=3'))).status,503);
  assert.equal((await handle(get(route+'/quote?lots=2&token=extra'))).status,400);
  assert.equal((await handle(get(route+'/quote?lots=2&lots=2'))).status,400);
  assert.equal((await handle(get('/market/12/asks/042/quote?lots=2'))).status,404);
  assert.equal((await handle(new Request('https://another.example'+route+'/quote?lots=2'))).status,421);
});

test('a price cannot advertise payment without BOTH independent authority and custody',async()=>{
  for(const config of [
    {active:true},{active:true,admitBuyer:()=>true},
    {active:true,settlementOperation:{execute:()=>{throw Error('not for payment');}}},
  ]) assert.equal((await create(config)(post(route+'/buy'))).status,503);
  const handle=create({active:true,admitBuyer:()=>true,
    settlementOperation:{execute:async()=>({status:202,body:{status:'settlement_pending',retryPayment:false}})}});
  const response=await handle(post(route+'/buy'));
  assert.equal(response.status,402);
  assert.ok(response.headers.get('PAYMENT-REQUIRED'));
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('a signed request invokes authorized custody once; invalid signatures cannot dispatch',async()=>{
  let admissions=0,executions=0;
  const handle=create({active:true,
    admitBuyer:async({instruction})=>{
      admissions++;return instruction.packet.payload.buyIntent.buyer===A('b');
    },
    settlementOperation:{execute:async()=>{
      executions++;return {status:202,body:{status:'settlement_pending',retryPayment:false}};
    }},
  });
  const challenge=quote({resource:{url:origin+route+'/buy'}});
  const header=paymentHeader(challenge);
  const response=await handle(post(route+'/buy',{'payment-signature':header}));
  assert.equal(response.status,202);
  assert.equal((await response.json()).retryPayment,false);
  assert.equal(executions,1);assert.equal(admissions,1);
  assert.equal((await handle(post(route+'/buy',{'payment-signature':'invalid'}))).status,400);
  assert.equal(executions,1);
  const refused=create({active:true,admitBuyer:()=>false,
    settlementOperation:{execute:async()=>{throw Error('must not act');}}});
  assert.equal((await refused(post(route+'/buy',{'payment-signature':header}))).status,403);
});

test('uncertain EVM broadcast is not called a failed payment or permission to retry',async()=>{
  const handle=create({active:true,admitBuyer:()=>true,
    settlementOperation:{execute:async()=>{throw Error('broadcast unknown');}}});
  const challenge=quote({resource:{url:origin+route+'/buy'}});
  const response=await handle(post(route+'/buy',{'payment-signature':paymentHeader(challenge)}));
  assert.equal(response.status,202);
  assert.deepEqual(await response.json(),{status:'settlement_pending',retryPayment:false});
});

test('a live loopback HTTP transport can actually consume the same Fetch application',async()=>{
  const handler=create();
  const server=createServer(async(req,res)=>{
    try {
      const request=new Request(origin+req.url,{method:req.method,headers:req.headers});
      const result=await handler(request);
      res.writeHead(result.status,Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch {res.writeHead(500);res.end();}
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+route+'/quote?lots=2');
    assert.equal(response.status,200);
    assert.equal((await response.json()).quote.amount,'1111000');
  }finally{server.close();await once(server,'close');}
});


test('signed buyer payment reuses its exact recent source block after chain advancement',async()=>{
  let latest=125, pinnedReads=0, executions=0;
  const moving=({resource,pinnedQuoteBlock,pinnedQuoteBlockHash})=>{
    const requestedBlock=pinnedQuoteBlock??latest;
    if(pinnedQuoteBlock !== undefined){
      pinnedReads++;
      if(pinnedQuoteBlockHash !== N('8')) throw Error('reorganization');
    }
    const q=quote({resource});
    const original=JSON.parse(Buffer.from(q.headers['PAYMENT-REQUIRED'],'base64'));
    original.accepts[0].extra.quoteBlock=String(requestedBlock);
    original.accepts[0].extra.quoteBlockHash=N('8');
    return {...q,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(original)).toString('base64')}};
  };
  const handler=create({active:true,quoteMarket:moving,admitBuyer:()=>true,
    settlementOperation:{execute:async()=>{
      executions++;
      return {status:202,body:{status:'settlement_pending',retryPayment:false}};
    }}});
  const challenge=await handler(post(route+'/buy'));
  assert.equal(challenge.status,402);
  const signed=paymentHeader({headers:{'PAYMENT-REQUIRED':challenge.headers.get('PAYMENT-REQUIRED')}});
  latest=126;
  const paid=await handler(post(route+'/buy',{'payment-signature':signed}));
  assert.equal(paid.status,202);
  assert.equal(pinnedReads,1);
  assert.equal(executions,1);
});


test('only matching independently settled fills produce canonical PAYMENT-RESPONSE on HTTP 200',async()=>{
  const original=quote({resource:{url:origin+route+'/buy'}});
  const signed=paymentHeader(original);
  const settled={status:200,body:{status:'filled',transactionHash:N('6'),network:'eip155:84532',
    market:A('c'),askId:'42',lots:'2',recipient:A('b'),amount:'1111000',
    sourceEconomicEvent:{type:'EvmAgentPredictionAskFilled',chain:'eip155:84532',
      blockNumber:125,blockHash:N('8'),transactionHash:N('6'),logIndex:6,
      emitter:A('c'),event:'AskFilled'}}};
  const handler=create({active:true,admitBuyer:()=>true,settlementOperation:{execute:async()=>settled}});
  const response=await handler(post(route+'/buy',{'payment-signature':signed}));
  assert.equal(response.status,200);
  const head=response.headers.get('PAYMENT-RESPONSE');
  assert.ok(head);
  assert.deepEqual(JSON.parse(Buffer.from(head,'base64')),{
    success:true,transaction:N('6'),network:'eip155:84532',payer:A('b'),
  });
  assert.equal((await response.json()).status,'filled');
  const forged=create({active:true,admitBuyer:()=>true,
    settlementOperation:{execute:async()=>({status:200,body:{...settled.body,amount:'999'}})}});
  const refused=await forged(post(route+'/buy',{'payment-signature':signed}));
  assert.equal(refused.status,409);
  assert.equal(refused.headers.get('PAYMENT-RESPONSE'),null);
  assert.deepEqual(await refused.json(),{status:'settlement_receiving_conflict',retryPayment:false});
});

test('deterministic custody preflight refusal is a real 409, never a fabricated pending charge',async()=>{
  const challenge=quote({resource:{url:origin+route+'/buy'}});
  const signed=paymentHeader(challenge);
  for(const refusal of ['order_intent_conflict','preflight_refused']){
    const handle=create({active:true,admitBuyer:()=>true,
      settlementOperation:{execute:async()=>({status:409,body:{status:refusal,retryPayment:false}})}});
    const response=await handle(post(route+'/buy',{'payment-signature':signed}));
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{status:refusal,retryPayment:false});
    assert.equal(response.headers.get('PAYMENT-RESPONSE'),null);
  }
});

test('HTTP refuses a settlement without any original on-chain economic event provenance',async()=>{
  const original=quote({resource:{url:origin+route+'/buy'}});
  const signed=paymentHeader(original);
  const fake={status:200,body:{status:'filled',transactionHash:N('6'),network:'eip155:84532',
    market:A('c'),askId:'42',lots:'2',recipient:A('b'),amount:'1111000'}};
  const handler=create({active:true,admitBuyer:()=>true,
    settlementOperation:{execute:async()=>fake}});
  const result=await handler(post(route+'/buy',{'payment-signature':signed}));
  assert.equal(result.status,409);
  assert.equal(result.headers.get('PAYMENT-RESPONSE'),null);
  assert.equal((await result.json()).status,'settlement_receiving_conflict');
});
