import { createHash } from 'node:crypto';
import { readAgentOrderPayment, settleAgentOrder } from './agent-prediction-x402-v2.mjs';

/** The existing Solidity market's exact tuple ABI, not ordinary x402 exact. */
export const TAKE_ASK_AUTHORIZED_ABI =
  'function takeAskAuthorized((address buyer,uint256 askId,uint256 lots,uint256 maxTotal,uint256 deadline,bytes32 nonce,bytes32 paymentNonce) intent,bytes buySignature,(uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature) payment)';
export const BUY_ASK_TYPES = Object.freeze({ BuyAsk: [
  { name:'buyer',type:'address' },{ name:'askId',type:'uint256' },
  { name:'lots',type:'uint256' },{ name:'maxTotal',type:'uint256' },
  { name:'deadline',type:'uint256' },{ name:'nonce',type:'bytes32' },
  { name:'paymentNonce',type:'bytes32' },
] });
export const RECEIVE_AUTHORIZATION_TYPES = Object.freeze({ ReceiveWithAuthorization: [
  { name:'from',type:'address' },{ name:'to',type:'address' },
  { name:'value',type:'uint256' },{ name:'validAfter',type:'uint256' },
  { name:'validBefore',type:'uint256' },{ name:'nonce',type:'bytes32' },
] });
const ADDRESS=/^0x[0-9a-fA-F]{40}$/u;
const HASH=/^0x[0-9a-fA-F]{64}$/u;
const HEX=/^0x(?:[0-9a-fA-F]{2})*$/u;
const UINT256=(1n<<256n)-1n;
const ZERO='0x'+'0'.repeat(40);

function address(value,label) {
  if(typeof value!=='string'||!ADDRESS.test(value)||value.toLowerCase()===ZERO)
    throw new TypeError(label+' requires nonzero EVM address');
  return value.toLowerCase();
}
function hash(value,label) {
  if(typeof value!=='string'||!HASH.test(value))throw new TypeError(label+' requires EVM hash');
  return value.toLowerCase();
}
function uint(value,label,allowZero=true) {
  if((typeof value!=='string'&&typeof value!=='bigint'&&typeof value!=='number')||
    !/^(0|[1-9][0-9]*)$/u.test(String(value)))throw new TypeError(label+' requires exact uint256');
  const n=BigInt(value);
  if(n>UINT256||(!allowZero&&n===0n))throw new RangeError(label+' exceeds allowed range');
  return n;
}
function instructionOf(value) {
  if(!value?.packet?.payload?.buyIntent||!value?.packet?.payload?.authorization||
    !value.requirement?.extra)throw new TypeError('one parsed and admitted signed order is required');
  return value;
}

/** Semantic purchase identity is independent of JSON key order or packet framing.
 * The incumbent transaction-effect custody owns write-ahead state and nonce use.
 */
export function sponsoredFillExecutionId(value) {
  const {packet,requirement}=instructionOf(value);
  const intent=packet.payload.buyIntent,auth=packet.payload.authorization;
  const body={
    type:'561-agent-prediction-sponsored-fill-v1',network:requirement.network,
    market:address(requirement.payTo,'market'),asset:address(requirement.asset,'asset'),
    buyer:address(intent.buyer,'buyer'),askId:uint(intent.askId,'askId').toString(),
    lots:uint(intent.lots,'lots').toString(),value:uint(auth.value,'value').toString(),
    buyNonce:hash(intent.nonce,'buyNonce'),paymentNonce:hash(auth.nonce,'paymentNonce'),
  };
  return 'ni:///sha-256;'+createHash('sha256').update(JSON.stringify(body)).digest('base64url');
}

function argumentsOf(value) {
  const {packet,requirement}=instructionOf(value);
  const intent=packet.payload.buyIntent,authorization=packet.payload.authorization;
  return {
    intent:[address(intent.buyer,'buyer'),uint(intent.askId,'askId'),uint(intent.lots,'lots'),
      uint(intent.maxTotal,'maxTotal'),uint(intent.deadline,'deadline'),
      hash(intent.nonce,'buyNonce'),hash(intent.paymentNonce,'paymentNonce')],
    buySignature:packet.payload.buySignature,
    payment:[uint(authorization.validAfter,'validAfter'),uint(authorization.validBefore,'validBefore'),
      hash(authorization.nonce,'paymentNonce'),authorization.signature],
    to:address(requirement.payTo,'market'),
  };
}
function typedDataOf(value) {
  const {packet,requirement}=instructionOf(value);
  const intent=packet.payload.buyIntent,auth=packet.payload.authorization;
  const chainId=uint(requirement.network.split(':')[1],'chainId',false);
  return {
    buy:{
      domain:{name:'561 Agent Prediction Market PoC',version:'1',chainId,
        verifyingContract:address(requirement.payTo,'market')},
      types:BUY_ASK_TYPES,
      message:{buyer:intent.buyer,askId:BigInt(intent.askId),lots:BigInt(intent.lots),
        maxTotal:BigInt(intent.maxTotal),deadline:BigInt(intent.deadline),
        nonce:intent.nonce,paymentNonce:intent.paymentNonce},
      signature:packet.payload.buySignature,
    },
    receive:{
      domain:{name:requirement.extra.name,version:requirement.extra.version,chainId,
        verifyingContract:address(requirement.asset,'asset')},
      types:RECEIVE_AUTHORIZATION_TYPES,
      message:{from:auth.from,to:auth.to,value:BigInt(auth.value),
        validAfter:BigInt(auth.validAfter),validBefore:BigInt(auth.validBefore),nonce:auth.nonce},
      signature:auth.signature,
    },
  };
}

/** Composes the SOURCE-OWNED signed EVM transaction-effect custody; no new
 * wallet, signer, durable payment ledger or retry/rebroadcast machinery.
 * prepareSignedFill is an independently authorized account signer capability.
 * independentReceipt must come from a separately trusted chain-reading owner.
 * Neither a paid route nor a real-money mandate is activated here.
 */
export function createCustodiedAgentPredictionSettlement({
  network,marketAddress,assetAddress,marketCodeHash,assetCodeHash,sponsorAddress,
  maxGasLimit,maxFeePerGasWei,maxGasCostWei,
  provider,custody,prepareSignedFill,independentReceipt,
  implementation={},
}={}) {
  const market=address(marketAddress,'marketAddress'),asset=address(assetAddress,'assetAddress');
  const sponsor=address(sponsorAddress,'sponsorAddress');
  hash(marketCodeHash,'marketCodeHash');hash(assetCodeHash,'assetCodeHash');
  const gasLimit=uint(maxGasLimit,'maxGasLimit',false),gasFee=uint(maxFeePerGasWei,'maxFeePerGasWei',false);
  const gasCost=uint(maxGasCostWei,'maxGasCostWei',false);
  if(gasLimit*gasFee>gasCost)throw new RangeError('gas envelope cannot cover declared worst-case sponsorship');
  if(!/^eip155:[1-9][0-9]*$/u.test(network??''))throw new TypeError('expected chain is required');
  if(!provider||!['getNetwork','getBlockNumber','getCode','call'].every(p=>typeof provider[p]==='function'))
    throw new TypeError('one EVM chain provider with call simulation is required');
  if(!custody||typeof custody.execute!=='function'||typeof prepareSignedFill!=='function'||
    typeof independentReceipt!=='function')
    throw new TypeError('native signed transaction custody, preparer and independent receiver required');

  const loadEthers=async()=>implementation.ethers??await import('ethers');
  const orderCall=async(verified)=>{
    const lib=await loadEthers();
    const coder=implementation.encodeMarketCall??((args)=>new lib.Interface([TAKE_ASK_AUTHORIZED_ABI])
      .encodeFunctionData('takeAskAuthorized',[args.intent,args.buySignature,args.payment]));
    const args=argumentsOf(verified);
    const data=coder(args);
    if(typeof data!=='string'||!HEX.test(data)||data.length<10)
      throw new TypeError('market executor returned invalid atomic calldata');
    return {to:market,data,account:sponsor,chain:network,gasLimit,gasFee,gasCost,lib};
  };

  async function prepare(verified,executionId) {
    const {packet,requirement}=verified,token=requirement.extra;
    if(requirement.network!==network||address(requirement.payTo,'market')!==market||
       address(requirement.asset,'asset')!==asset||
       token.assetTransferMethod!=='eip3009-receive')
      throw new TypeError('funded market order is outside the accepted chain and token');
    const built=await orderCall(verified);
    const latest=await provider.getBlockNumber();
    const detected='eip155:'+String(BigInt((await provider.getNetwork()).chainId));
    if(detected!==network||!Number.isSafeInteger(latest)||latest<0)
      throw new Error('sponsorship provider is on a different or invalid chain');
    const [marketCode,tokenCode,buyerCode]=await Promise.all([
      provider.getCode(market,latest),provider.getCode(asset,latest),
      provider.getCode(address(packet.payload.buyIntent.buyer,'buyer'),latest),
    ]);
    const keccak=implementation.hashCode??built.lib.keccak256;
    if(typeof keccak!=='function'||keccak(marketCode)?.toLowerCase()!==marketCodeHash.toLowerCase()||
      keccak(tokenCode)?.toLowerCase()!==assetCodeHash.toLowerCase())
      throw new Error('market/token code identity drifted from admitted deployment');
    // SignatureChecker in the market is authoritative for contract-wallet
    // ERC-1271 signers. EOAs also receive deterministic off-chain recovery.
    if(buyerCode==='0x'){
      const recover=implementation.verifyTypedData??built.lib.verifyTypedData;
      const types=typedDataOf(verified);
      for(const command of [types.buy,types.receive]){
        if(address(recover(command.domain,command.types,command.message,command.signature),
          'recovered signature')!==address(packet.payload.buyIntent.buyer,'buyer'))
          throw new Error('buyer did not sign both bound EIP-712 commands');
      }
    }
    // Simulate the *market call*, never the normal x402 direct token transfer.
    await provider.call({from:sponsor,to:market,data:built.data,value:0n});
    const signed=await prepareSignedFill(Object.freeze({
      executionId,network,market,asset,buyer:packet.payload.buyIntent.buyer,
      calldata:built.data,gasLimit,gasFee,gasCost,
      order:structuredClone(verified),
    }));
    if(typeof signed?.serializedTransaction!=='string'||!signed.evidence||
      typeof signed.expiresAt!=='string')
      throw new TypeError('source-bound signed sponsor transaction and custody evidence required');
    const parse=implementation.decodeSignedTransaction??built.lib.Transaction.from;
    const tx=parse(signed.serializedTransaction);
    if(tx.from?.toLowerCase()!==sponsor||tx.to?.toLowerCase()!==market||
      BigInt(tx.chainId)!==BigInt(network.split(':')[1])||
      tx.data?.toLowerCase()!==built.data.toLowerCase()||BigInt(tx.value)!==0n||
      tx.type!==2||BigInt(tx.gasLimit)>gasLimit||
      BigInt(tx.maxFeePerGas)>gasFee||
      BigInt(tx.gasLimit)*BigInt(tx.maxFeePerGas)>gasCost)
      throw new TypeError('prepared signed transaction violates exact market call or sponsorship envelope');
    return signed;
  }

  return Object.freeze({
    execute:async({paymentSignatureHeader,challenge,instruction,marketId,askId,lots}={})=>{
      const verified=readAgentOrderPayment(paymentSignatureHeader,challenge);
      if(instruction?.requirement?.network!==verified.requirement.network||
          marketId!==verified.requirement.extra.marketId||
          askId!==verified.requirement.extra.askId||lots!==verified.requirement.extra.lots)
        return {status:409,body:{status:'order_intent_conflict',retryPayment:false}};
      const executionId=sponsoredFillExecutionId(verified);
      let effect,preflightRefusal=null;
      try {
        // Custody first: if this exact transaction already reached an uncertain
        // broadcast, it reconciles without preparing/signing it again.
        effect=await custody.execute({executionId,prepareSigned:async()=>{
          try { return await prepare(verified,executionId); }
          catch(error) { preflightRefusal=error; throw error; }
        }});
      }catch{
        // A rejection of the *fresh prepare callback* precedes custody's
        // pending signed transaction. Reconciliation/recording errors do not.
        // Never turn an ambiguous post-broadcast failure into permission to pay again.
        return preflightRefusal === null
          ? {status:202,body:{status:'settlement_pending',retryPayment:false}}
          : {status:409,body:{status:'preflight_refused',retryPayment:false}};
      }
      if(effect?.executionId!==executionId||effect?.status!=='reconciled'||
        effect?.disposition!=='succeeded'||!HASH.test(effect.transactionHash??''))
        return {status:202,body:{status:'settlement_pending',retryPayment:false}};
      // The transaction-effect owner already acknowledged its irreversible
      // signed transaction. The separate receiver proves token/share economics.
      return settleAgentOrder({paymentSignatureHeader,challenge,
        facilitator:async()=>({status:'submitted',transactionHash:effect.transactionHash,
          network,buyer:verified.packet.payload.buyIntent.buyer}),independentReceipt});
    },
    reconcile:()=>typeof custody.reconcile==='function'
      ? custody.reconcile():Promise.reject(new TypeError('native custody reconcile unavailable')),
  });
}
