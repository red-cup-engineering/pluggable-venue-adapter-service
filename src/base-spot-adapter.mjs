import {reconcileBaseNativeUsdc} from '@red-cup-engineering/account-evidence-reconciliation-service';
import { Interface, Transaction, getAddress, keccak256 } from 'ethers';
import { semanticIdOf } from '@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity';
import { allocationsFor } from '@red-cup-engineering/mandate-portfolio-allocation-service/market-game';
import { createTransactionEffectCustody } from './transaction-effect-custody.mjs';
const identify = semanticIdOf('brokerage.base-spot.record');
export const BASE_SPOT = Object.freeze({
 maximumObservedTokens:128,
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
const freezeRecord=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeRecord(child);Object.freeze(value);}return value;};
const record=body=>freezeRecord({id:identify(body),...structuredClone(body)});
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
 async function readAccount({tokens=[]}={}){
  if(!Array.isArray(tokens)||tokens.length>BASE_SPOT.maximumObservedTokens||tokens.some(token=>typeof token!=='string'))throw new TypeError('bounded-base-token-addresses-required');
  const declared=tokens.map(getAddress).sort();if(new Set(declared).size!==declared.length)throw new TypeError('unique-base-token-addresses-required');
  const observedAt=clock();const reading=await readPool.requestAtBoundary({operation:async ctx=>{
   const balances={nativeBalanceWei:await call({method:'eth_getBalance',params:[BASE_SPOT.address]},ctx),usdcBalance:await call(balanceCall(BASE_SPOT.usdc),ctx),wrappedEtherBalance:await call(balanceCall(BASE_SPOT.wrappedEther),ctx),tokenBalances:[]};
   // Public calls only, four at a time, all pinned by the same upstream carrier.
   for(let i=0;i<declared.length;i+=4){const batch=await Promise.allSettled(declared.slice(i,i+4).map(async token=>({token,balanceAtomic:erc20.decodeFunctionResult('balanceOf',await call(balanceCall(token),ctx))[0].toString()})));
    const providerFailure=batch.find(result=>result.status==='rejected'&&['PUBLIC_EVM_PROVIDER_READ_FAILED','PUBLIC_EVM_READ_LIMIT'].includes(result.reason?.code));
    if(providerFailure)throw providerFailure.reason;
    batch.forEach((result,j)=>balances.tokenBalances.push(result.status==='fulfilled'?{...result.value,status:'observed'}:{token:declared[i+j],status:'refused',reason:result.reason.message}));
   }
   return balances;
  }});
  return record({type:'BaseSpotAccountObservation',chainId:8453,address:BASE_SPOT.address,observedAt,finality:'pinned-block-not-finalized',boundary:reading.boundary,provider:reading.provider,
   nativeBalanceWei:BigInt(reading.value.nativeBalanceWei).toString(),usdcBalanceAtomic:erc20.decodeFunctionResult('balanceOf',reading.value.usdcBalance)[0].toString(),wrappedEtherBalanceWei:erc20.decodeFunctionResult('balanceOf',reading.value.wrappedEtherBalance)[0].toString(),tokenBalances:reading.value.tokenBalances,
   coverage:{scope:'native ETH, native USDC, WETH and explicitly declared ERC-20 balances',fullWallet:false,usdValuation:false,nftAndProtocolPositions:false,declaredTokens:declared},attempts:reading.attempts,failures:reading.failures});
 }
 async function quoteNativeToUsdc({amountInWei,fee=500}={}){
  const amount=positive(amountInWei,'input');if(![100,500,3000,10000].includes(fee))throw new RangeError('uniswap-fee-tier-required');
  const observedAt=clock();const reading=await readPool.requestAtBoundary({blockTag:'finalized',operation:async ctx=>({
   nativeBalanceWei:await call({method:'eth_getBalance',params:[BASE_SPOT.address]},ctx),
   routerCode:await call({method:'eth_getCode',params:[BASE_SPOT.router]},ctx),
   quote:await call({method:'eth_call',params:[{to:BASE_SPOT.quoter,data:quoter.encodeFunctionData('quoteExactInputSingle',[[BASE_SPOT.wrappedEther,BASE_SPOT.usdc,amount,fee,0]])}]},ctx),
  })});
  if(reading.value.routerCode==='0x')throw new TypeError('base-router-code-absent');
  if(BigInt(reading.value.nativeBalanceWei)<amount)throw new RangeError('native-input-exceeds-observed-wallet-balance');
  const [amountOut,sqrtPriceX96After,initializedTicksCrossed,gasEstimate]=quoter.decodeFunctionResult('quoteExactInputSingle',reading.value.quote);
  if(amountOut<=0n)throw new RangeError('positive-pool-output-required');
  return record({type:'BaseNativeUsdcQuote',chainId:8453,address:BASE_SPOT.address,protocol:BASE_SPOT.protocol,observedAt,finality:reading.finality?.finalized===true?'finalized':'pinned-block-not-finalized',finalized:reading.finality?.finalized===true,...(reading.finality?{finalityEvidence:reading.finality}:{}),boundary:reading.boundary,provider:reading.provider,
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

/** Exact USD risk check for the existing Group grant. These inputs must be
 * resolved by the production executor from current authority and independent
 * books; this pure check neither supplies that authority nor signs anything. */
export function admitNativeUsdcExecution({quote,preparation,grant,revocation,marks,at=new Date().toISOString()}={}){
 currentQuote(quote,at);
 const {id,...body}=preparation??{};
 if(!id||identify(body)!==id||body.type!=='BaseNativeUsdcExecutionPreparation'||body.quote!==quote.id||body.chainId!==8453||!sameAddress(body.address,BASE_SPOT.address))throw new TypeError('exact-base-execution-preparation-required');
 const validation=validateNativeUsdcSwap({transaction:body.transaction,quote,at});
 if(body.signed!==false||body.broadcast!==false)throw new TypeError('unsigned-base-preparation-required');
 if(grant?.id!=='yanagi-base-wallet-trading-by-emsenn-personal-chief-financial-officer'||grant.under!=='561-group'||grant.over!=='emsenn-personal-chief-financial-officer'||grant.account?.venue!=='eip155:8453'||!sameAddress(grant.account.address,BASE_SPOT.address))throw new TypeError('recorded-base-principal-grant-required');
 if(grant.limits?.max_value_per_transaction!=='25 USD at the pre-trade quote'||grant.limits?.max_loss_per_utc_day!=='50 USD marked at the venue quote')throw new TypeError('recorded-base-risk-limits-required');
 const now=Date.parse(at),fresh=value=>{const age=now-Date.parse(value);return Number.isFinite(age)&&age>=0&&age<=60000;};
 if(!Number.isFinite(now)||!Number.isFinite(Date.parse(grant.valid_until))||now>=Date.parse(grant.valid_until)||grant.revoked===true)throw new TypeError('current-base-grant-required');
 const utcDay=new Date(now).toISOString().slice(0,10);
 if(!fresh(body.observedAt))throw new TypeError('fresh-base-preparation-required');
 if(revocation?.grant!==grant.id||revocation.effective!==false||!fresh(revocation.observedAt))throw new TypeError('current-base-revocation-reading-required');
 if(marks?.address!==BASE_SPOT.address||marks.utcDay!==utcDay||!fresh(marks.observedAt)||!Array.isArray(marks.sourceEvidence)||!marks.sourceEvidence.length||marks.sourceEvidence.some(id=>typeof id!=='string'||!/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/.test(id)))throw new TypeError('current-source-linked-base-books-required');
 const usd=(value,signed=false)=>{
  if(typeof value!=='string'||!(signed?/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/:/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).test(value))throw new TypeError('exact-usd-mark-required');
  const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.');
  const n=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));return negative?-n:n;
 };
 const nativePrice=usd(marks.nativeUsdPerEth);if(nativePrice<=0n)throw new TypeError('positive-native-usd-mark-required');
 const fees=integer(body.feeReserveWei,'fee-reserve'),value=positive(body.transaction.value,'input');
 const gasLimit=positive(body.transaction.gasLimit,'gas-limit'),maxFee=positive(body.transaction.maxFeePerGas,'max-fee');
 const minimumFees=gasLimit*maxFee+2n*(integer(body.l1FeeUpperBoundWei,'l1-fee')+integer(body.operatorFeeWei,'operator-fee'));
 if(fees!==minimumFees||integer(body.gasReserveWei,'gas-reserve')!==fees||integer(body.nativeBalanceWei,'native-balance')<value+2n*fees)throw new TypeError('base-preparation-fee-or-funding-mismatch');
 const ceiling=(numerator,denominator)=>(numerator+denominator-1n)/denominator;
 const transactionRisk=ceiling((value+fees)*nativePrice,1000000000000000000n);
 if(transactionRisk>25000000n)throw new RangeError('base-transaction-exceeds-25-usd-grant');
 const equity=usd(marks.currentEquityUsd),opening=usd(marks.dayStartEquityUsd),flows=usd(marks.netExternalFlowsUsd,true),reserved=usd(marks.reservedLossUsd);
 const rawLoss=opening+flows-equity,markedLoss=rawLoss>0n?rawLoss:0n;
 if(markedLoss+reserved+transactionRisk>50000000n)throw new RangeError('base-day-loss-reservations-exceed-50-usd-grant');
 const {from,...transaction}=body.transaction;
 const signingMandate={chain:'base',address:BASE_SPOT.address,allowedContracts:[BASE_SPOT.router],maxAmountWei:value.toString(),expiresAt:new Date(Math.min(Date.parse(grant.valid_until),validation.deadline*1000,Date.parse(quote.observedAt)+60000)).toISOString(),unsignedTransactionHash:Transaction.from(transaction).unsignedHash};
 return record({type:'BaseNativeUsdcRiskAdmission',signingMandate,preparation:id,quote:quote.id,grant:grant.id,principal:'561-group',address:BASE_SPOT.address,at,utcDay:marks.utcDay,sourceEvidence:marks.sourceEvidence,transactionRiskUsdMicros:transactionRisk.toString(),markedDayLossUsdMicros:markedLoss.toString(),reservedLossUsdMicros:reserved.toString(),signed:false,broadcast:false,currentAuthorityAndPendingNonceRecheckRequired:true});
}

/** The sole native-ETH/USDC effect path. All records and office authority come
 * from the host's trusted resolver; request bodies contain references only.
 * Custody and public observations remain upstream capabilities. */
export function createBaseNativeUsdcExecutor({directory,resolveExecutionRecords,signTransaction,rpc,recordOutcome,clock=()=>new Date().toISOString()}={}){
 if(typeof resolveExecutionRecords!=='function'||typeof signTransaction!=='function')throw new TypeError('trusted-base-execution-resolver-and-signer-required');
 const custody=createTransactionEffectCustody({directory,address:BASE_SPOT.address,chainId:8453,rpc,recordOutcome,clock});
 const reference=value=>{if(typeof value!=='string'||!/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/.test(value))throw new TypeError('content-addressed-base-execution-reference-required');return value;};
 // Decimal representation of a planner quantity, including scientific notation,
 // rounded DOWN into funding atoms. Floating-point slack cannot authorize wei.
 const fundingAtoms=value=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new TypeError('positive-planned-eth-funding-required');
  const [mantissa,exponent='0']=String(value).split('e'),[whole,fraction='']=mantissa.split('.');
  const coefficient=BigInt(whole+fraction),shift=18+Number(exponent)-fraction.length;
  return shift>=0?coefficient*10n**BigInt(shift):coefficient/10n**BigInt(-shift);
 };
 async function resolve(references){
  const records=structuredClone(await resolveExecutionRecords(references));
  const {quote,preparation,decision,principalAuthorization}=records;
  if(quote?.id!==references.quoteReference||preparation?.id!==references.preparationReference||decision?.id!==references.decisionReference)throw new TypeError('resolved-base-execution-reference-mismatch');
  const at=clock(),age=Date.parse(at)-Date.parse(principalAuthorization?.observedAt);
  if(!reference(principalAuthorization?.id)||principalAuthorization.authorized!==true||principalAuthorization.principal!=='561-group'||principalAuthorization.office!=='emsenn-personal-chief-financial-officer'||principalAuthorization.grant!==records.grant?.id||!Number.isFinite(age)||age<0||age>60000)throw new TypeError('current-base-principal-office-authorization-required');
  const admission=admitNativeUsdcExecution({...records,at});
  const allocations=allocationsFor(decision,{venue:'evm',instrument:'USDC',side:'long',chainId:8453,protocol:BASE_SPOT.protocol,at});
  if(allocations.length!==1||allocations[0].id!==quote.id||allocations[0].blockHash!==quote.boundary.blockHash||allocations[0].funding?.instrument!=='ETH'||BigInt(preparation.transaction.value)>fundingAtoms(allocations[0].funding.units))throw new TypeError('exact-joint-decision-base-native-funding-required');
  return freezeRecord({...records,admission});
 }
 async function recheckNetwork(records){
  const {quote,preparation}=records;
  const [block,code,nonce,chain]=await Promise.all([
   rpc({method:'eth_getBlockByNumber',params:['0x'+BigInt(quote.boundary.blockNumber).toString(16),false]}),
   rpc({method:'eth_getCode',params:[BASE_SPOT.router,'latest']}),
   rpc({method:'eth_getTransactionCount',params:[BASE_SPOT.address,'pending']}),
   rpc({method:'eth_chainId',params:[]}),
  ]);
  if(BigInt(chain)!==8453n||block?.hash?.toLowerCase()!==quote.boundary.blockHash.toLowerCase()||keccak256(code)!==quote.routerCodeHash)throw new TypeError('current-base-chain-quote-router-required');
  if(BigInt(nonce)!==BigInt(preparation.transaction.nonce))throw new TypeError('base-pending-nonce-changed');
 }
 async function execute(request){
  if(!request||Object.keys(request).some(key=>!['quoteReference','preparationReference','decisionReference'].includes(key)))throw new TypeError('base-execution-reference-only-request-required');
  const references=Object.freeze(Object.fromEntries(['quoteReference','preparationReference','decisionReference'].map(key=>[key,reference(request[key])])));
  const executionId=identify({type:'BaseNativeUsdcExecution',...references});
  return custody.execute({executionId,prepareSigned:async()=>{
   let records=await resolve(references);await recheckNetwork(records);
   records=await resolve(references);
   const result=await signTransaction({chain:'base',mandate:records.admission.signingMandate,payload:{contract:BASE_SPOT.router,valueWei:records.preparation.transaction.value,transaction:records.preparation.transaction},now:clock()});
   if(result?.signed!==true)throw new TypeError('base-signing-refused');
   const signed=Transaction.from(result.signature);
   if(!signed.isSigned()||signed.from!==BASE_SPOT.address||signed.unsignedHash!==records.admission.signingMandate.unsignedTransactionHash)throw new TypeError('signed-base-transaction-differs-from-admission');
   // Signing can take time. Re-resolve revocation and reservations, then recheck
   // the actual pending nonce before signed bytes enter effect custody.
   records=await resolve(references);await recheckNetwork(records);
   if(signed.unsignedHash!==records.admission.signingMandate.unsignedTransactionHash)throw new TypeError('base-admission-changed-during-signing');
   return {serializedTransaction:signed.serialized,expiresAt:records.admission.signingMandate.expiresAt,evidence:{...references,admission:records.admission.id,principalAuthorization:records.principalAuthorization.id,grant:records.grant.id,sourceEvidence:records.admission.sourceEvidence}};
  }});
 }
 return Object.freeze({execute,reconcile:custody.reconcile});
}

/** Recovery has no signing or broadcast surface. Observation can record a
 * finalized receipt while financial accounting is still explicitly pending. */
export function createBaseNativeUsdcRecovery({directory,rpc,recordOutcome,clock}={}){
 const readOnlyRpc=request=>{
  if(!['eth_getTransactionReceipt','eth_getBlockByNumber'].includes(request.method))throw new TypeError('base-recovery-read-only-rpc-required');
  return rpc(request);
 };
 const custody=createTransactionEffectCustody({directory,address:BASE_SPOT.address,chainId:8453,rpc:readOnlyRpc,recordOutcome,clock});
 return Object.freeze({reconcile:custody.reconcile});
}

/** Finalized receipt + adjacent block-hash-pinned account quantities. Read only.
 * Failure or unrelated movements leave the existing effect in accounting custody. */
export async function reconcileBaseNativeUsdcOutcome({observed,rpc}={}) {
 if(observed?.chainId!==8453||!sameAddress(observed.address,BASE_SPOT.address)||typeof rpc!=='function')throw new TypeError('fixed-base-accounting-bindings-required');
 const receipt=observed.receipt,number=BigInt(receipt.blockNumber);
 if(number<=0n)throw new TypeError('accounting-parent-block-required');
 const afterBlock=await rpc({method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]});
 if(afterBlock?.hash?.toLowerCase()!==receipt.blockHash.toLowerCase())throw new TypeError('accounting-canonical-block-required');
 const beforeNumber='0x'+(number-1n).toString(16),beforeBlock=await rpc({method:'eth_getBlockByNumber',params:[beforeNumber,false]});
 if(beforeBlock?.hash?.toLowerCase()!==afterBlock.parentHash.toLowerCase()||BigInt(beforeBlock.number)!==number-1n)throw new TypeError('accounting-canonical-parent-required');
 const read=async block=>{
  const boundary={blockHash:block.hash,requireCanonical:true};
  const [native,usdc,weth]=await Promise.all([
   rpc({method:'eth_getBalance',params:[BASE_SPOT.address,boundary]}),
   rpc({method:'eth_call',params:[{to:BASE_SPOT.usdc,data:erc20.encodeFunctionData('balanceOf',[BASE_SPOT.address])},boundary]}),
   rpc({method:'eth_call',params:[{to:BASE_SPOT.wrappedEther,data:erc20.encodeFunctionData('balanceOf',[BASE_SPOT.address])},boundary]}),
  ]);
  return {chainId:8453,address:BASE_SPOT.address,blockNumber:block.number,blockHash:block.hash,parentHash:block.parentHash,nativeBalanceWei:BigInt(native).toString(),usdcBalanceAtomic:erc20.decodeFunctionResult('balanceOf',usdc)[0].toString(),wrappedEtherBalanceWei:erc20.decodeFunctionResult('balanceOf',weth)[0].toString()};
 };
 const boundary={blockHash:afterBlock.hash,requireCanonical:true};
 const [before,after,transaction,operatorRaw]=await Promise.all([
  read(beforeBlock),read(afterBlock),rpc({method:'eth_getTransactionByHash',params:[observed.transactionHash]}),
  rpc({method:'eth_call',params:[{to:gasOracleAddress,data:gasOracle.encodeFunctionData('getOperatorFee',[BigInt(receipt.gasUsed)])},boundary]}),
 ]);
 const operatorFeeWei=gasOracle.decodeFunctionResult('getOperatorFee',operatorRaw)[0].toString();
 const finalized=await rpc({method:'eth_getBlockByNumber',params:['finalized',false]});
 const canonical=await rpc({method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]});
 if(BigInt(finalized.number)<number||canonical.hash.toLowerCase()!==afterBlock.hash.toLowerCase())throw new TypeError('accounting-finalized-canonical-recheck-required');
 return reconcileBaseNativeUsdc({observed,transaction,before,after,operatorFeeWei});
}
