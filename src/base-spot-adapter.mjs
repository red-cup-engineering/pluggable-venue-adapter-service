import { Interface, Transaction, getAddress, keccak256 } from 'ethers';
import { semanticIdOf } from '@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity';
const identify = semanticIdOf('brokerage.base-spot.record');
export const BASE_SPOT = Object.freeze({
 chainId:8453,address:'0x224C08A8526751887a83e2711B167f890c6D078d',
 wrappedEther:'0x4200000000000000000000000000000000000006',
 usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
 router:'0x2626664c2603336E57B271c5C0b26F421741e481',
 quoter:'0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
 protocol:'uniswap-v3-native-usdc',
 sources:Object.freeze(['https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments','https://developers.circle.com/stablecoins/usdc-contract-addresses']),
});
const gasOracleAddress='0x420000000000000000000000000000000000000F';
const gasOracle=new Interface(['function baseFee() view returns(uint256)','function getL1FeeUpperBound(uint256 unsignedTxSize) view returns(uint256)','function getOperatorFee(uint256 gasUsed) view returns(uint256)']);
const erc20=new Interface(['function balanceOf(address) view returns(uint256)']);
const quoter=new Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const router=new Interface(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)','function multicall(uint256 deadline,bytes[] data) payable returns(bytes[] results)']);
const integer=(value,label)=>{if(typeof value!=='string'||!/^\d+$/.test(value))throw new TypeError(label+'-exact-integer-required');return BigInt(value);};
const positive=(value,label)=>{const n=integer(value,label);if(n<=0n)throw new RangeError(label+'-positive-required');return n;};
const record=body=>Object.freeze({id:identify(body),...body});
const sameAddress=(a,b)=>getAddress(a)===getAddress(b);
function currentQuote(quote,at){
 if(!quote||quote.type!=='BaseNativeUsdcQuote'||quote.chainId!==BASE_SPOT.chainId||quote.protocol!==BASE_SPOT.protocol)throw new TypeError('base-native-usdc-quote-required');
 const {id,...body}=quote;if(identify(body)!==id)throw new TypeError('base-quote-identity-mismatch');
 if(!sameAddress(quote.address,BASE_SPOT.address))throw new TypeError('authorized-base-wallet-required');
 const age=Date.parse(at)-Date.parse(quote.observedAt);
 if(!Number.isFinite(age)||age<0||age>60000)throw new RangeError('fresh-base-quote-required');
 positive(quote.amountInWei,'input');positive(quote.amountOutAtomic,'output');
}

/** Public account and executable pool quotes share the upstream fixed-block reader.
 * This adapter holds no signing key and supplies no authority or capital. */
export function createBaseSpotAdapter({readPool,clock=()=>new Date().toISOString()}={}){
 if(readPool?.chain?.id!==BASE_SPOT.chainId||typeof readPool.requestAtBoundary!=='function')throw new TypeError('base-fixed-block-reader-required');
 const call=async(request,{request:rpc})=>rpc(request);
 const balanceCall=(token)=>({method:'eth_call',params:[{to:token,data:erc20.encodeFunctionData('balanceOf',[BASE_SPOT.address])}]});
 async function readAccount(){
  const observedAt=clock();const reading=await readPool.requestAtBoundary({operation:async ctx=>({
   nativeBalanceWei:await call({method:'eth_getBalance',params:[BASE_SPOT.address]},ctx),
   usdcBalance:await call(balanceCall(BASE_SPOT.usdc),ctx),wrappedEtherBalance:await call(balanceCall(BASE_SPOT.wrappedEther),ctx),
  })});
  return record({type:'BaseSpotAccountObservation',chainId:8453,address:BASE_SPOT.address,observedAt,finality:'pinned-block-not-finalized',boundary:reading.boundary,provider:reading.provider,
   nativeBalanceWei:BigInt(reading.value.nativeBalanceWei).toString(),usdcBalanceAtomic:erc20.decodeFunctionResult('balanceOf',reading.value.usdcBalance)[0].toString(),wrappedEtherBalanceWei:erc20.decodeFunctionResult('balanceOf',reading.value.wrappedEtherBalance)[0].toString(),attempts:reading.attempts,failures:reading.failures});
 }
 async function quoteNativeToUsdc({amountInWei,fee=500}={}){
  const amount=positive(amountInWei,'input');if(![100,500,3000,10000].includes(fee))throw new RangeError('uniswap-fee-tier-required');
  const observedAt=clock();const reading=await readPool.requestAtBoundary({operation:async ctx=>({
   nativeBalanceWei:await call({method:'eth_getBalance',params:[BASE_SPOT.address]},ctx),
   routerCode:await call({method:'eth_getCode',params:[BASE_SPOT.router]},ctx),
   quote:await call({method:'eth_call',params:[{to:BASE_SPOT.quoter,data:quoter.encodeFunctionData('quoteExactInputSingle',[[BASE_SPOT.wrappedEther,BASE_SPOT.usdc,amount,fee,0]])}]},ctx),
  })});
  if(reading.value.routerCode==='0x')throw new TypeError('base-router-code-absent');
  if(BigInt(reading.value.nativeBalanceWei)<amount)throw new RangeError('native-input-exceeds-observed-wallet-balance');
  const [amountOut,sqrtPriceX96After,initializedTicksCrossed,gasEstimate]=quoter.decodeFunctionResult('quoteExactInputSingle',reading.value.quote);
  if(amountOut<=0n)throw new RangeError('positive-pool-output-required');
  return record({type:'BaseNativeUsdcQuote',chainId:8453,address:BASE_SPOT.address,protocol:BASE_SPOT.protocol,observedAt,finality:'pinned-block-not-finalized',boundary:reading.boundary,provider:reading.provider,
   router:BASE_SPOT.router,routerCodeHash:keccak256(reading.value.routerCode),tokenIn:BASE_SPOT.wrappedEther,tokenOut:BASE_SPOT.usdc,fee,amountInWei:amount.toString(),amountOutAtomic:amountOut.toString(),nativeBalanceWei:BigInt(reading.value.nativeBalanceWei).toString(),
   sqrtPriceX96After:sqrtPriceX96After.toString(),initializedTicksCrossed:Number(initializedTicksCrossed),quoterGasEstimate:gasEstimate.toString(),sources:BASE_SPOT.sources,attempts:reading.attempts,failures:reading.failures});
 }
 async function prepareNativeUsdcSwap({quote,minimumOutputAtomic,deadline}={}){
  const observedAt=clock();const transaction=buildNativeUsdcSwap({quote,minimumOutputAtomic,deadline,at:observedAt});
  const reading=await readPool.requestAtBoundary({operation:async ctx=>{
   const invoke=(method,params)=>ctx.request({method,params});
   const oracle=async(name,args=[])=>gasOracle.decodeFunctionResult(name,await invoke('eth_call',[{to:gasOracleAddress,data:gasOracle.encodeFunctionData(name,args)}]))[0];
   const [balance,nonce,estimatedGas,baseFee,routerCode]=await Promise.all([
    invoke('eth_getBalance',[BASE_SPOT.address]),invoke('eth_getTransactionCount',[BASE_SPOT.address]),
    invoke('eth_estimateGas',[{from:transaction.from,to:transaction.to,data:transaction.data,value:'0x'+BigInt(transaction.value).toString(16)}]),
    oracle('baseFee'),invoke('eth_getCode',[BASE_SPOT.router]),
   ]);
   if(keccak256(routerCode)!==quote.routerCodeHash)throw new TypeError('base-router-code-changed-since-quote');
   const estimate=BigInt(estimatedGas);if(estimate<=0n||estimate>1000000n)throw new RangeError('bounded-swap-gas-estimate-required');
   const gasLimit=(estimate*3n+1n)/2n,maxPriorityFeePerGas=1000000n,maxFeePerGas=baseFee*2n+maxPriorityFeePerGas;
   const nonceValue=BigInt(nonce);if(nonceValue>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('transaction-nonce-out-of-range');
   const {from,...body}=transaction;
   const envelope={...body,type:2,nonce:Number(nonceValue),gasLimit:gasLimit.toString(),maxFeePerGas:maxFeePerGas.toString(),maxPriorityFeePerGas:maxPriorityFeePerGas.toString()};
   const unsignedSize=(Transaction.from(envelope).unsignedSerialized.length-2)/2;
   const [l1FeeUpperBound,operatorFee]=await Promise.all([oracle('getL1FeeUpperBound',[unsignedSize]),oracle('getOperatorFee',[gasLimit])]);
   // Rollup fees are separate from gasLimit * maxFeePerGas. Reserve twice
   // their current estimates and another full fee budget for later gas needs.
   const feeReserveWei=gasLimit*maxFeePerGas+2n*(l1FeeUpperBound+operatorFee);
   const gasReserveWei=feeReserveWei;
   if(BigInt(balance)<BigInt(transaction.value)+feeReserveWei+gasReserveWei)throw new RangeError('native-balance-does-not-fund-swap-and-rollup-fees');
   return {transaction:{...envelope,from},nonceAtBoundary:nonceValue.toString(),estimatedGas:estimate.toString(),l2BaseFeeWei:baseFee.toString(),l1FeeUpperBoundWei:l1FeeUpperBound.toString(),operatorFeeWei:operatorFee.toString(),feeReserveWei:feeReserveWei.toString(),gasReserveWei:gasReserveWei.toString(),nativeBalanceWei:BigInt(balance).toString()};
  }});
  validateNativeUsdcSwap({transaction:reading.value.transaction,quote,at:clock()});
  return record({type:'BaseNativeUsdcExecutionPreparation',quote:quote.id,observedAt,chainId:8453,address:BASE_SPOT.address,boundary:reading.boundary,provider:reading.provider,...reading.value,nonceDisposition:'observed-at-pinned-block-recheck-pending-before-signing',authorityAdmissionRequired:true,signed:false,broadcast:false,
   sources:[...BASE_SPOT.sources,'https://specs.optimism.io/protocol/fjord/predeploys.html','https://raw.githubusercontent.com/ethereum-optimism/optimism/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol']});
 }
 return Object.freeze({readAccount,quoteNativeToUsdc,prepareNativeUsdcSwap});
}

/** Restricted calldata, never an arbitrary router call or token approval.
 * Admission, gas funding, daily loss accounting and signing remain the executor's duties. */
export function buildNativeUsdcSwap({quote,minimumOutputAtomic,deadline,at=new Date().toISOString()}={}){
 currentQuote(quote,at);const minimum=positive(minimumOutputAtomic,'minimum-output');const output=positive(quote.amountOutAtomic,'quoted-output');
 if(minimum>output||minimum*10000n<output*9975n)throw new RangeError('minimum-output-must-preserve-quoted-25bps-slippage-bound');
 const nowSeconds=Math.floor(Date.parse(at)/1000);
 if(!Number.isSafeInteger(deadline)||deadline<=nowSeconds||deadline>nowSeconds+60)throw new RangeError('base-swap-deadline-within-one-minute-required');
 const swap=router.encodeFunctionData('exactInputSingle',[[BASE_SPOT.wrappedEther,BASE_SPOT.usdc,quote.fee,BASE_SPOT.address,positive(quote.amountInWei,'input'),minimum,0]]);
 return Object.freeze({chainId:8453,from:BASE_SPOT.address,to:BASE_SPOT.router,value:quote.amountInWei,data:router.encodeFunctionData('multicall(uint256,bytes[])',[deadline,[swap]])});
}

/** Recheck the actual transaction at the custody boundary, including nested calldata. */
export function validateNativeUsdcSwap({transaction,quote,at=new Date().toISOString()}={}){
 currentQuote(quote,at);
 if(Number(transaction?.chainId)!==8453||!sameAddress(transaction.from,BASE_SPOT.address)||!sameAddress(transaction.to,BASE_SPOT.router)||BigInt(transaction.value)!==positive(quote.amountInWei,'input'))throw new TypeError('base-transaction-wallet-chain-router-value-mismatch');
 const outer=router.parseTransaction({data:transaction.data,value:transaction.value});
 if(outer?.signature!=='multicall(uint256,bytes[])'||outer.args[1].length!==1)throw new TypeError('one-deadline-bound-base-swap-required');
 const inner=router.parseTransaction({data:outer.args[1][0]});
 if(inner?.name!=='exactInputSingle')throw new TypeError('exact-input-base-swap-required');
 const params=inner.args[0];
 if(!sameAddress(params.tokenIn,BASE_SPOT.wrappedEther)||!sameAddress(params.tokenOut,BASE_SPOT.usdc)||!sameAddress(params.recipient,BASE_SPOT.address)||Number(params.fee)!==quote.fee||params.amountIn!==positive(quote.amountInWei,'input')||params.sqrtPriceLimitX96!==0n)throw new TypeError('base-swap-route-recipient-amount-mismatch');
 const canonical=buildNativeUsdcSwap({quote,minimumOutputAtomic:params.amountOutMinimum.toString(),deadline:Number(outer.args[0]),at});
 if(transaction.data.toLowerCase()!==canonical.data.toLowerCase())throw new TypeError('canonical-base-swap-calldata-required');
 return Object.freeze({quote:quote.id,deadline:Number(outer.args[0]),amountInWei:quote.amountInWei,minimumOutputAtomic:params.amountOutMinimum.toString(),recipient:BASE_SPOT.address,approved:false,signed:false});
}
