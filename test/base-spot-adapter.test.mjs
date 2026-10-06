import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {createBaseSpotAdapter,buildNativeUsdcSwap,validateNativeUsdcSwap,BASE_SPOT} from '../src/base-spot-adapter.mjs';
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
