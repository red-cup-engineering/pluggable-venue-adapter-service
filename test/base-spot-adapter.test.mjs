import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {createBaseSpotAdapter,buildNativeUsdcSwap,validateNativeUsdcSwap,admitNativeUsdcExecution,BASE_SPOT} from '../src/base-spot-adapter.mjs';
const at='2026-10-06T12:00:00Z';
const quoter=new Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
async function fixture(){
 const calls=[];const pool={chain:{id:8453},requestAtBoundary:async({operation})=>({boundary:{chainId:8453,blockNumber:'10',blockHash:'0x'+'ab'.repeat(32)},provider:{id:'fixture'},attempts:[],failures:[],value:await operation({request:async request=>{calls.push(request);if(request.method==='eth_getBalance')return '0x16bcc41e90000';if(request.method==='eth_getCode')return '0x6000';return quoter.encodeFunctionResult('quoteExactInputSingle',[250000n,1n,0,80000n]);}})})};
 const adapter=createBaseSpotAdapter({readPool:pool,clock:()=>at});const quote=await adapter.quoteNativeToUsdc({amountInWei:'100000000000000'});const transaction=buildNativeUsdcSwap({quote,minimumOutputAtomic:'249375',deadline:Math.floor(Date.parse(at)/1000)+30,at});return {calls,quote,transaction};
}
test('Base calldata binds native input, self recipient, pair, deadline and quoted slippage',async()=>{
 const {quote,transaction}=await fixture();assert.equal(validateNativeUsdcSwap({transaction,quote,at}).signed,false);
 for(const altered of [{...transaction,chainId:1},{...transaction,to:BASE_SPOT.usdc},{...transaction,from:BASE_SPOT.usdc},{...transaction,value:'200000000000000'}])assert.throws(()=>validateNativeUsdcSwap({transaction:altered,quote,at}),/mismatch/);
 assert.throws(()=>buildNativeUsdcSwap({quote,minimumOutputAtomic:'1',deadline:Math.floor(Date.parse(at)/1000)+30,at}),/slippage/);
 assert.throws(()=>buildNativeUsdcSwap({quote,minimumOutputAtomic:'249375',deadline:Math.floor(Date.parse(at)/1000)+120,at}),/deadline/);
 assert.throws(()=>validateNativeUsdcSwap({transaction,quote:{...quote,amountInWei:'200000000000000'},at}),/identity-mismatch/);
 assert.throws(()=>validateNativeUsdcSwap({transaction,quote,at:'2026-10-06T12:02:00Z'}),/fresh/);
});
test('multicall cannot smuggle another operation or an outbound recipient',async()=>{
 const {quote,transaction}=await fixture();const router=new Interface(['function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)','function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)']);
 const parsed=router.parseTransaction({data:transaction.data});const extra={...transaction,data:router.encodeFunctionData('multicall',[parsed.args[0],[parsed.args[1][0],parsed.args[1][0]]])};assert.throws(()=>validateNativeUsdcSwap({transaction:extra,quote,at}),/one-deadline/);
 const swap=router.encodeFunctionData('exactInputSingle',[[BASE_SPOT.wrappedEther,BASE_SPOT.usdc,500,BASE_SPOT.usdc,100000000000000n,249375n,0]]);const outbound={...transaction,data:router.encodeFunctionData('multicall',[parsed.args[0],[swap]])};assert.throws(()=>validateNativeUsdcSwap({transaction:outbound,quote,at}),/recipient/);
});

const oracle=new Interface(['function baseFee() view returns(uint256)','function getL1FeeUpperBound(uint256 unsignedTxSize) view returns(uint256)','function getOperatorFee(uint256 gasUsed) view returns(uint256)']);
async function preparationFixture({balance=1000000000000000n,estimate=166384n,nonce=7n,changedCode=false}={}){
 const requests=[];let preparing=false;
 const pool={chain:{id:8453},requestAtBoundary:async({operation})=>({boundary:{chainId:8453,blockNumber:'10',blockHash:'0x'+'ab'.repeat(32)},provider:{id:'fixture'},attempts:[],failures:[],value:await operation({request:async request=>{
  requests.push(request);
  if(request.method==='eth_getBalance')return '0x'+balance.toString(16);
  if(request.method==='eth_getCode')return preparing&&changedCode?'0x6001':'0x6000';
  if(request.method==='eth_getTransactionCount')return '0x'+nonce.toString(16);
  if(request.method==='eth_estimateGas')return '0x'+estimate.toString(16);
  if(request.params[0].to===BASE_SPOT.quoter)return quoter.encodeFunctionResult('quoteExactInputSingle',[250000n,1n,0,73010n]);
  const call=oracle.parseTransaction({data:request.params[0].data});
  return oracle.encodeFunctionResult(call.name,[call.name==='baseFee'?1000000n:call.name==='getL1FeeUpperBound'?128284995305n:5000n]);
 }})})};
 const adapter=createBaseSpotAdapter({readPool:pool,clock:()=>at});
 const quote=await adapter.quoteNativeToUsdc({amountInWei:'100000000000000'});preparing=true;
 return {requests,quote,prepare:()=>adapter.prepareNativeUsdcSwap({quote,minimumOutputAtomic:'249375',deadline:Math.floor(Date.parse(at)/1000)+30})};
}
test('execution preparation budgets actual simulation and separate rollup fees while retaining gas',async()=>{
 const {requests,prepare}=await preparationFixture();const result=await prepare();
 assert.equal(result.estimatedGas,'166384');assert.equal(result.transaction.gasLimit,'249576');
 const expected=249576n*3000000n+2n*(128284995305n+5000n);
 assert.equal(result.feeReserveWei,expected.toString());assert.equal(result.gasReserveWei,expected.toString());
 assert.equal(result.transaction.nonce,7);assert.equal(result.signed,false);assert.equal(result.broadcast,false);assert.equal(result.authorityAdmissionRequired,true);
 const simulated=requests.find(r=>r.method==='eth_estimateGas');assert.equal(simulated.params[0].to,BASE_SPOT.router);assert.equal(simulated.params[0].from,BASE_SPOT.address);
});
test('preparation refuses insufficient gas funding, changed router, excessive gas and unsafe nonce',async()=>{
 for(const [options,pattern] of [[{balance:100000000000000n},/rollup-fees/],[{changedCode:true},/code-changed/],[{estimate:1000001n},/bounded-swap-gas/],[{nonce:9007199254740992n},/nonce-out-of-range/]]){
  const {prepare}=await preparationFixture(options);await assert.rejects(prepare,pattern);
 }
});

const grant={id:'yanagi-base-wallet-trading-by-emsenn-personal-chief-financial-officer',under:'561-group',over:'emsenn-personal-chief-financial-officer',account:{venue:'eip155:8453',address:BASE_SPOT.address},limits:{max_value_per_transaction:'25 USD at the pre-trade quote',max_loss_per_utc_day:'50 USD marked at the venue quote'},valid_until:'2027-01-01'};
const revocation={grant:grant.id,effective:false,observedAt:at};
const marks={address:BASE_SPOT.address,utcDay:'2026-10-06',observedAt:at,nativeUsdPerEth:'2500',dayStartEquityUsd:'100',netExternalFlowsUsd:'0',currentEquityUsd:'100',reservedLossUsd:'0',sourceEvidence:['ni:///sha-256;'+'a'.repeat(43)]};
test('Base admission includes gas in exact USD caps and aggregate marked-day loss reservations',async()=>{
 const {quote,prepare}=await preparationFixture();const preparation=await prepare();
 const admit=changes=>admitNativeUsdcExecution({quote,preparation,grant,revocation,marks,at,...changes});
 const result=admit({});assert.equal(result.signed,false);assert.equal(result.broadcast,false);assert.equal(result.currentAuthorityAndPendingNonceRecheckRequired,true);
 assert.throws(()=>{result.signingMandate.allowedContracts.push(BASE_SPOT.usdc);},TypeError);
 assert.throws(()=>{result.sourceEvidence[0]='changed';},TypeError);
 assert.ok(BigInt(result.transactionRiskUsdMicros)>250000n);
 assert.throws(()=>admit({marks:{...marks,nativeUsdPerEth:'250000'}}),/25-usd/);
 assert.throws(()=>admit({marks:{...marks,currentEquityUsd:'50'}}),/50-usd/);
 assert.throws(()=>admit({marks:{...marks,currentEquityUsd:'70',reservedLossUsd:'20'}}),/50-usd/);
 // Deposits must not disguise losses: starting 100 plus 50 deposited and
 // current equity 100 is still a 50 USD loss for the day.
 assert.throws(()=>admit({marks:{...marks,netExternalFlowsUsd:'50'}}),/50-usd/);
 assert.throws(()=>admit({revocation:{...revocation,effective:true}}),/revocation/);
 assert.throws(()=>admit({marks:{...marks,sourceEvidence:[]}}),/source-linked/);
 assert.throws(()=>admit({marks:{...marks,utcDay:'2026-10-05'}}),/source-linked/);
 assert.throws(()=>admit({marks:{...marks,nativeUsdPerEth:'2500.0000001'}}),/exact-usd/);
 assert.throws(()=>admit({preparation:{...preparation,feeReserveWei:'0'}}),/exact-base-execution/);
});


test('Base quote requests finalized state and retains the reader finality witness',async()=>{
 const tags=[];const witness={finalized:true,headNumber:'10',headHash:'0x'+'ab'.repeat(32)};
 const readPool={chain:{id:8453},requestAtBoundary:async({blockTag,operation})=>{
  tags.push(blockTag);return {boundary:{chainId:8453,blockNumber:'10',blockHash:witness.headHash},provider:{id:'fixture'},attempts:[],failures:[],finality:witness,value:await operation({request:async request=>{
   if(request.method==='eth_getBalance')return '0x16bcc41e90000';
   if(request.method==='eth_getCode')return '0x6000';
   return quoter.encodeFunctionResult('quoteExactInputSingle',[250000n,1n,0,80000n]);
  }})};
 }};
 const quote=await createBaseSpotAdapter({readPool,clock:()=>at}).quoteNativeToUsdc({amountInWei:'100000000000000'});
 assert.deepEqual(tags,['finalized']);assert.equal(quote.finalized,true);assert.equal(quote.finality,'finalized');assert.deepEqual(quote.finalityEvidence,witness);
 const old=await fixture();assert.equal(old.quote.finalized,false);
});

test('declared token balances share the account boundary and remain explicitly partial and unvalued',async()=>{
 const erc20=new Interface(['function balanceOf(address) view returns(uint256)']);const extra='0x1111111111111111111111111111111111111111',bad='0x2222222222222222222222222222222222222222';let boundaries=0;const calls=[];
 const pool={chain:{id:8453},requestAtBoundary:async({operation})=>{boundaries++;return {boundary:{chainId:8453,blockNumber:'10',blockHash:'0x'+'ab'.repeat(32)},provider:{id:'fixture'},attempts:[],failures:[],value:await operation({request:async request=>{calls.push(request);if(request.method==='eth_getBalance')return '0x64';if(request.params[0].to===bad)throw new Error('token contract refused');return erc20.encodeFunctionResult('balanceOf',[request.params[0].to===extra?123456789012345678901n:1n]);}})};}};
 const adapter=createBaseSpotAdapter({readPool:pool,clock:()=>at});const row=await adapter.readAccount({tokens:[bad,extra]});assert.equal(boundaries,1);assert.equal(row.tokenBalances[0].balanceAtomic,'123456789012345678901');assert.equal(row.tokenBalances[1].status,'refused');assert.equal(row.coverage.fullWallet,false);assert.equal(row.coverage.usdValuation,false);assert.equal(row.nativeBalanceWei,'100');assert.equal(calls.filter(c=>c.method==='eth_call').length,4);assert.ok(calls.every(c=>['eth_call','eth_getBalance'].includes(c.method)));
 await assert.rejects(adapter.readAccount({tokens:[extra,extra]}),/unique/);await assert.rejects(adapter.readAccount({tokens:Array(129).fill(extra)}),/bounded/);await assert.rejects(adapter.readAccount({tokens:['not-an-address']}));assert.equal(boundaries,1);
});
