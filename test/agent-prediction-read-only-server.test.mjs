import assert from 'node:assert/strict';
import test from 'node:test';
import { serveAgentPredictionReadOnly } from '../scripts/serve-agent-prediction-read-only.mjs';
import { offerAgentOrder } from '../src/agent-prediction-x402-v2.mjs';

const address=d=>'0x'+d.repeat(40);
const quote=({resource})=>{
  const now=Math.floor(Date.now()/1000);
  return offerAgentOrder({resource,nowSeconds:now,requirement:{
    scheme:'561-agent-prediction-order-v1',network:'eip155:84532',amount:'1111000',
    asset:address('e'),payTo:address('c'),maxTimeoutSeconds:45,
    extra:{paymentFlow:'upfront',assetTransferMethod:'eip3009-receive',
      name:'Synthetic x402 Collateral',version:'2',marketId:'12',askId:'42',lots:'2',
      outcome:0,unitPrice:'550000',makerAmount:'1100000',tradeFee:'11000',
      providerFee:'4400',protocolFee:'6600',provider:address('1'),maker:address('2'),
      protocolRecipient:address('3'),quoteBlock:'125',expiresAt:String(now+60),
      buyIntentEip712Domain:{name:'561 Agent Prediction Market PoC',version:'1'}
    }
  }});
};

test('real loopback client reads an HTTPS-bound market quote without a purchase',async()=>{
  const started=await serveAgentPredictionReadOnly({
    source:{publicOrigin:'https://market.example/'},provider:{},quoteMarket:quote,
  });
  try{
    const preview=await fetch(started.origin+'/market/12/asks/42/quote?lots=2');
    assert.equal(preview.status,200);
    const result=await preview.json();
    assert.equal(result.quote.amount,'1111000');
    assert.equal(result.payable,false);
    const buy=await fetch(started.origin+'/market/12/asks/42/buy',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lots:'2'})
    });
    assert.equal(buy.status,503);
    assert.equal((await buy.json()).paid,false);
  }finally{await started.close();}
});

test('nonloopback listening and credential-bearing RPC do not open the service',async()=>{
  await assert.rejects(serveAgentPredictionReadOnly({
    source:{publicOrigin:'https://market.example/'},provider:{},host:'0.0.0.0',
  }),/loopback/u);
  await assert.rejects(serveAgentPredictionReadOnly({
    source:{publicOrigin:'https://market.example/'},
    rpcUrl:'http://user:secret@localhost:8545',
    openProvider:()=>{throw Error('must not open provider');},
  }),/credential-free/u);
});
