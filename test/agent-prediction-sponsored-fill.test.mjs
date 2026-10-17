import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {offerAgentOrder,readAgentOrderPayment} from '../src/agent-prediction-x402-v2.mjs';
import {
  createCustodiedAgentPredictionSettlement, sponsoredFillExecutionId,
  TAKE_ASK_AUTHORIZED_ABI, BUY_ASK_TYPES, RECEIVE_AUTHORIZATION_TYPES,
} from '../src/agent-prediction-sponsored-fill.mjs';
const A=c=>'0x'+c.repeat(40),N=c=>'0x'+c.repeat(64),SIG=c=>'0x'+c.repeat(130);
const network='eip155:84532',market=A('c'),asset=A('e'),buyer=A('b'),sponsor=A('f');
const marketCode='0x60016000',assetCode='0x60026000',calldata='0x1122334455667788';
const amount='1111000',gasLimit=250000n,gasFee=10000000000n,gasCost=gasLimit*gasFee;
const txHash=N('6');
const now=()=>Math.floor(Date.now()/1000);
function sample(){
  const t=now();
  const resource={url:'https://market.example/market/12/asks/42/buy'};
  const terms={scheme:'561-agent-prediction-order-v1',network,asset,payTo:market,amount,maxTimeoutSeconds:45,
    extra:{paymentFlow:'upfront',assetTransferMethod:'eip3009-receive',name:'Synthetic x402 Collateral',
      version:'2',marketId:'12',askId:'42',lots:'2',outcome:0,unitPrice:'550000',makerAmount:'1100000',
      tradeFee:'11000',providerFee:'4400',protocolFee:'6600',provider:A('1'),maker:A('2'),protocolRecipient:A('3'),
      quoteBlock:'125',quoteBlockHash:N('8'),expiresAt:String(t+60),
      buyIntentEip712Domain:{name:'561 Agent Prediction Market PoC',version:'1'}}};
  const challenge=offerAgentOrder({resource,requirement:terms});
  const payment={x402Version:2,resource,accepted:terms,payload:{
    buyIntent:{buyer,askId:'42',lots:'2',maxTotal:amount,deadline:String(t+30),nonce:N('4'),paymentNonce:N('5')},
    buySignature:SIG('a'),
    authorization:{from:buyer,to:market,value:amount,validAfter:String(t-1),validBefore:String(t+40),
      nonce:N('5'),signature:SIG('b')},
  }};
  const paymentSignatureHeader=Buffer.from(JSON.stringify(payment)).toString('base64');
  return {challenge,paymentSignatureHeader,
    instruction:readAgentOrderPayment(paymentSignatureHeader,challenge),
    marketId:'12',askId:'42',lots:'2'};
}
function setup(overrides={}){
  const events=[];
  const provider={
    getNetwork:async()=>({chainId:84532n}), getBlockNumber:async()=>126,
    getCode:async(address,block)=>{
      events.push(['code',address,block]);
      return address===market?marketCode:address===asset?assetCode:'0x';
    },
    call:async(request)=>{events.push(['simulate',request]);return '0x';},
    ...overrides.provider,
  };
  const implementation={
    ethers:{}, encodeMarketCall:args=>{events.push(['encode',args]);return calldata;},
    hashCode:code=>code===marketCode?N('8'):code===assetCode?N('9'):'0x'+createHash('sha256').update(code).digest('hex'),
    verifyTypedData:(domain,types,msg,signature)=>{
      events.push(['recover',domain,types,msg,signature]);return buyer;
    },
    decodeSignedTransaction:()=>({from:sponsor,to:market,chainId:84532n, data:calldata,value:0n,
      type:2,gasLimit,maxFeePerGas:gasFee}),
    ...overrides.implementation,
  };
  const prepareSignedFill=async(input)=>{
    events.push(['prepare',input]);
    return {serializedTransaction:'0xdeadbeef',expiresAt:new Date(Date.now()+20000).toISOString(),
      evidence:{type:'AuthorizedSponsoredMarketCall',executionId:input.executionId}};
  };
  const custody=overrides.custody??{
    execute:async({executionId,prepareSigned})=>{
      events.push(['custody',executionId]);
      await prepareSigned();
      return {status:'reconciled',executionId,transactionHash:txHash,disposition:'succeeded'};
    },reconcile:async()=>({status:'no-pending-transaction'})
  };
  const independentReceipt=async()=>{
    events.push(['receive']);
    return {finalized:true,transactionStatus:1,network,transactionHash:txHash,
      market,asset,buyer,askId:'42',marketId:'12',lots:'2',outcome:0,
      paymentNonce:N('5'),buyNonce:N('4'),amount,maker:A('2'),provider:A('1'),protocolRecipient:A('3'),
      makerAmount:'1100000',providerFee:'4400',protocolFee:'6600',sourceEconomicEvent:{type:'EvmAgentPredictionAskFilled',chain:network,
        blockNumber:125,blockHash:N('8'),transactionHash:txHash,logIndex:6,
        emitter:market,event:'AskFilled'},authorizationNonceConsumed:true,
      buyerDebited:true,sharesReceived:true,feesSettled:true,backingConserved:true};
  };
  const operation=createCustodiedAgentPredictionSettlement({
    network,marketAddress:market,assetAddress:asset,marketCodeHash:N('8'),assetCodeHash:N('9'),
    sponsorAddress:sponsor,maxGasLimit:gasLimit,maxFeePerGasWei:gasFee,maxGasCostWei:gasCost,
    provider,custody,prepareSignedFill:overrides.prepareSignedFill??prepareSignedFill,
    independentReceipt:overrides.independentReceipt??independentReceipt,implementation,
  });
  return {events,operation,provider,custody};
}

test('real market ABI binds two different signed EIP-712 commands',()=>{
  assert.match(TAKE_ASK_AUTHORIZED_ABI,/takeAskAuthorized/u);
  assert.match(TAKE_ASK_AUTHORIZED_ABI,/paymentNonce/u);
  assert.equal(BUY_ASK_TYPES.BuyAsk.length,7);
  assert.equal(RECEIVE_AUTHORIZATION_TYPES.ReceiveWithAuthorization.length,6);
});

test('custody-backed authorized market fill simulates one call and yields filled result',async()=>{
  const {operation,events}=setup();
  const result=await operation.execute(sample());
  assert.equal(result.status,200);
  assert.deepEqual(result.body,{status:'filled',transactionHash:txHash,network,market,askId:'42',
    lots:'2',recipient:buyer,amount,
    sourceEconomicEvent:{type:'EvmAgentPredictionAskFilled',chain:network,
      blockNumber:125,blockHash:N('8'),transactionHash:txHash,logIndex:6,
      emitter:market,event:'AskFilled'}});
  assert.equal(events.filter(e=>e[0]==='simulate').length,1);
  assert.equal(events.filter(e=>e[0]==='prepare').length,1);
  assert.equal(events.filter(e=>e[0]==='receive').length,1);
  const recover=events.filter(e=>e[0]==='recover');
  assert.equal(recover.length,2);
  assert.deepEqual(new Set(recover.map(x=>x[1].verifyingContract)),new Set([market,asset]));
  assert.equal(recover[0][2].BuyAsk.length,7);
  assert.equal(recover[1][2].ReceiveWithAuthorization.length,6);
  assert.equal(events.find(e=>e[0]==='custody')[1].startsWith('ni:///sha-256;'),true);
});

test('semantic execution identity is stable under harmless JSON key order changes',()=>{
  const s=sample();
  const packet=JSON.parse(Buffer.from(s.paymentSignatureHeader,'base64'));
  const order=[...Object.entries(packet.payload.buyIntent)].reverse();
  const p1={packet,requirement:packet.accepted};
  packet.payload.buyIntent=Object.fromEntries(order);
  const p2={packet,requirement:packet.accepted};
  assert.equal(sponsoredFillExecutionId(p1),sponsoredFillExecutionId(p2));
});

test('foreign chain, altered source bytecode or invalid EOA signature never prepares a transaction',async()=>{
  const samples=[
    setup({provider:{getNetwork:async()=>({chainId:1n})}}),
    setup({provider:{getCode:async()=>'0x6000'}}),
    setup({implementation:{verifyTypedData:()=>A('1')}}),
    setup({provider:{call:async()=>{throw new Error('market contract refused');}}}),
  ];
  for(const {operation,events} of samples){
    const result=await operation.execute(sample());
    assert.equal(result.status,409);
    assert.equal(result.body.status,'preflight_refused');
    assert.equal(result.body.retryPayment,false);
    assert.equal(events.filter(e=>e[0]==='prepare').length,0);
    assert.equal(events.filter(e=>e[0]==='receive').length,0);
  }
});

test('signed sponsor transaction must match market, bytecode and bounded EIP-1559 gas',async()=>{
  for(const delta of [
    {to:A('1')},{from:A('1')},{data:'0xdeadbeef'},{value:1n},{type:0},
    {gasLimit:gasLimit+1n},{maxFeePerGas:gasFee+1n},{chainId:1n},
  ]){
    const base={from:sponsor,to:market,chainId:84532n,data:calldata,value:0n,type:2,gasLimit,maxFeePerGas:gasFee};
    const {operation,events}=setup({implementation:{decodeSignedTransaction:()=>({...base,...delta})}});
    const result=await operation.execute(sample());
    assert.equal(result.status,409);
    assert.equal(events.filter(e=>e[0]==='receive').length,0);
  }
});

test('prior pending transaction is reconciled by original custody without new signatures',async()=>{
  const cache=new Map();let creations=0;
  const custody={
    execute:async({executionId,prepareSigned})=>{
      if(cache.has(executionId))return cache.get(executionId);
      creations++;await prepareSigned();
      const pending={status:'pending-finality',executionId,transactionHash:txHash};
      cache.set(executionId,pending);return pending;
    },reconcile:async()=>({status:'pending-finality',transactionHash:txHash}),
  };
  const {operation,events}=setup({custody});
  const first=await operation.execute(sample());
  const replay=await operation.execute(sample());
  assert.equal(first.status,202);assert.equal(replay.status,202);
  assert.equal(creations,1);
  assert.equal(events.filter(e=>e[0]==='prepare').length,1);
  assert.equal((await operation.reconcile()).status,'pending-finality');
});

test('unrelated pending sponsor transaction cannot be claimed as current order',async()=>{
  const custody={execute:async()=>({status:'reconciled',executionId:'ni:///sha-256;'+('a'.repeat(43)),
    transactionHash:txHash,disposition:'succeeded'})};
  const {operation,events}=setup({custody});
  const response=await operation.execute(sample());
  assert.equal(response.status,202);
  assert.equal(events.filter(e=>e[0]==='receive').length,0);
});

test('smart-wallet signatures defer to actual on-chain SignatureChecker simulation',async()=>{
  let recovered=0;
  const {operation,events}=setup({provider:{getCode:async addr=>
    addr===market?marketCode:addr===asset?assetCode:'0x60006000'},
    implementation:{verifyTypedData:()=>{recovered++;throw Error('EOA verifier cannot read contract wallets');}}});
  assert.equal((await operation.execute(sample())).status,200);
  assert.equal(recovered,0);
  assert.equal(events.filter(e=>e[0]==='simulate').length,1);
});

test('no independent share/fee receiver is allowed to return a filled purchase',async()=>{
  const {operation}=setup({independentReceipt:async()=>{throw Error('independent provider offline');}});
  const result=await operation.execute(sample());
  assert.equal(result.status,202);
  assert.equal(result.body.status,'independent_receiving_pending');
});

test('wrong quote, order or beneficiary never requests account custody',async()=>{
  const {operation,events}=setup();
  const bad=await operation.execute({...sample(),askId:'43'});
  assert.equal(bad.status,409);
  assert.equal(events.filter(e=>e[0]==='custody').length,0);
});

test('financial gas sponsor limits cannot be imprecise JavaScript numbers',()=>{
  const cfg=setup().operation;
  assert.equal(typeof cfg.execute,'function');
  assert.throws(()=>createCustodiedAgentPredictionSettlement({
    network,marketAddress:market,assetAddress:asset,marketCodeHash:N('8'),assetCodeHash:N('9'),
    sponsorAddress:sponsor,maxGasLimit:Number.MAX_SAFE_INTEGER+2,maxFeePerGasWei:'10000000000',
    maxGasCostWei:'100000000000000000000000',provider:{getNetwork(){}},
    custody:{execute(){}},prepareSignedFill() {},independentReceipt() {},
  }),/imprecise JavaScript numeric amounts/u);
});
