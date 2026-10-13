import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kalshiOrderRiskCents,kalshiRestingRiskCents,
  kalshiRiskContractBounds,kalshiAccountRiskInputs,
  kalshiUsdCeilCents,kalshiPriceCents,kalshiCountNumber,
} from '../src/kalshi-risk-law.mjs';

const contract=()=>({
 type:'PrincipalBrokerageServiceContract',
 capital:{amount:100,currency:'USD'},
 risk:{
  maximumLossAmount:30,maximumOrderNotional:50,
  maximumAggregateNotional:100,concentrationLimit:.25,
 },
});
const account=()=>({
 equityCents:9500,freeCashCents:1200,
 positions:[{eventTicker:'KXHIGHNY-26OCT04',costCents:101}],
 resting:[{
  eventTicker:'KXHIGHNY-26OCT04',
  bookSide:'ask',count:2.5,countDecimal:'2.50',
  yesPriceDollars:'0.025',priceCents:2.5,
 }],
});

test('risk law uses exact YES and NO prices with fractional lots and rounds exposure UP',()=>{
 assert.equal(kalshiOrderRiskCents({count:'2.50',price:'0.025',side:'ask'}),244);
 assert.equal(kalshiOrderRiskCents({count:'2.50',price:'0.025',side:'bid'}),7);
 assert.equal(kalshiRestingRiskCents({count:'10.50',yesPriceDollars:'0.025',bookSide:'bid'}),27);
 assert.equal(kalshiRestingRiskCents({count:'2.50',yesPriceDollars:'0.025',bookSide:'ask'}),244);
 assert.equal(kalshiRestingRiskCents({count:'2.50',priceCents:'2.5',bookSide:'ask'}),244);
 assert.equal(kalshiUsdCeilCents('3.8800'),388);
 assert.equal(kalshiUsdCeilCents('0.005'),1);
 assert.equal(kalshiPriceCents('0.025'),2.5);
 assert.equal(kalshiCountNumber('-4.00',{signed:true}),-4);
});

test('every principal risk cap is present, bounded and conservatively rounded DOWN',()=>{
 const bounds=kalshiRiskContractBounds(contract());
 assert.deepEqual(bounds,{
  capitalCents:10000,maximumLossCents:3000,maximumOrderCents:5000,
  maximumAggregateCents:10000,maximumEventCents:2500,
 });
 const tiny={...contract(),risk:{...contract().risk,maximumOrderNotional:'0.505'}};
 assert.equal(kalshiRiskContractBounds(tiny).maximumOrderCents,50);
 assert.equal(kalshiOrderRiskCents({count:1,price:'0.495',side:'ask'}),51);
});
test('missing risk limits cannot become NaN and bypass authority',()=>{
 for(const field of ['maximumLossAmount','maximumOrderNotional','maximumAggregateNotional','concentrationLimit']){
  const broken=contract();delete broken.risk[field];
  assert.throws(()=>kalshiRiskContractBounds(broken),/required/);
  for(const invalid of [NaN,Infinity,-Infinity,null,'bad','']){
   const c=contract();c.risk[field]=invalid;
   assert.throws(()=>kalshiRiskContractBounds(c),/required|negative|limit/);
  }
 }
 for(const invalid of [undefined,0,NaN,Infinity,'Infinity',-100]){
  const c=contract();c.capital.amount=invalid;
  assert.throws(()=>kalshiRiskContractBounds(c));
 }
 const incomplete=contract();delete incomplete.risk;
 assert.throws(()=>kalshiRiskContractBounds(incomplete),/complete-USD/);
 const nonUsd=contract();nonUsd.capital.currency='USDC';
 assert.throws(()=>kalshiRiskContractBounds(nonUsd),/complete-USD/);
});
test('risk law rejects non-finite or impossible order quantities and prices',()=>{
 for(const count of [0,'0.001',NaN,Infinity,'Infinity',-1,Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>kalshiOrderRiskCents({count,price:.3,side:'bid'}));
 }
 for(const price of [undefined,0,1,-.01,1.01,NaN,Infinity,'-0.3','nope']){
  assert.throws(()=>kalshiOrderRiskCents({count:1,price,side:'bid'}));
 }
 assert.throws(()=>kalshiOrderRiskCents({count:1,price:.5,side:'buy'}),/book-side/);
});
test('all observed account risk amounts and open order collateral are exact and non-negotiable',()=>{
 const original=account();
 const accepted=kalshiAccountRiskInputs(original);
 assert.equal(accepted.equityCents,9500n);
 assert.equal(accepted.freeCashCents,1200n);
 assert.equal(accepted.resting[0].riskCents,244n);
 assert.equal(accepted.positions[0].costCents,101n);
 for(const value of [undefined,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>kalshiAccountRiskInputs({...original,freeCashCents:value}),/integer-cents/);
 }
 assert.throws(()=>kalshiAccountRiskInputs({...original,positions:undefined}),/complete-observed/);
 assert.throws(()=>kalshiAccountRiskInputs({...original,resting:[{...original.resting[0],countDecimal:'invalid'}]}));
 assert.throws(()=>kalshiAccountRiskInputs({...original,positions:[{...original.positions[0],costCents:-1}]}));
});
test('cent conversion never accepts unsafe source quantities or meaningless Infinity',()=>{
 assert.throws(()=>kalshiUsdCeilCents('90071992547409999'),/unsafe-integer/);
 assert.throws(()=>kalshiCountNumber('90071992547409999'),/safe-representation/);
 assert.throws(()=>kalshiPriceCents('1.5'),/outside-one-dollar/);
});
