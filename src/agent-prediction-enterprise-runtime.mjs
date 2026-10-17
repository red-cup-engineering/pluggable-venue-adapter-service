import { createAgentPredictionOrderHttpHandler } from './agent-prediction-http.mjs';
import { offerAgentOrderFromChain } from './agent-prediction-chain-offer.mjs';
import { createCustodiedAgentPredictionSettlement } from './agent-prediction-sponsored-fill.mjs';

/** Source-owned composition of the on-chain quote, the existing signed EVM
 * transaction custody and a buyer-facing Fetch resource. The enterprise
 * owner supplies an admitted original-market configuration, buyer mandate,
 * sponsor signer capability and an independent Ethereum receipt provider.
 * No identity, role, funds, ledger, durable queue or live service is created.
 */
export function createAgentPredictionEnterpriseRuntime({
  publicOrigin,quoteProvider,quoteSource,readMarketQuote=offerAgentOrderFromChain,
  activated=false,buyerMandate,
  sponsorProvider,sponsorPolicy,custody,prepareSignedFill,readMarketReceipt,
  implementation,
}={}) {
  if(!quoteProvider||typeof quoteProvider.getNetwork!=='function'||
      !quoteSource||typeof quoteSource!=='object'||Array.isArray(quoteSource)) {
    throw new TypeError('admitted on-chain market quotation binding is required');
  }
  if(typeof readMarketQuote!=='function')throw new TypeError('native market quote producer is required');
  let operation;
  if(activated===true){
    if(typeof buyerMandate!=='function'||typeof readMarketReceipt!=='function'||
        !custody||typeof custody.execute!=='function'||typeof prepareSignedFill!=='function'||
        !sponsorPolicy||typeof sponsorPolicy!=='object'||
        !sponsorProvider||sponsorProvider===null||sponsorProvider===quoteProvider&&sponsorPolicy.requireDistinctQuoteProvider===true) {
      throw new TypeError('activated market requires explicit buyer, sponsor and independent chain-receiving capacities');
    }
    if(quoteSource.expectedNetwork!==sponsorPolicy.network||
       quoteSource.expectedAsset?.toLowerCase()!==sponsorPolicy.assetAddress?.toLowerCase()||
       quoteSource.marketAddress?.toLowerCase()!==sponsorPolicy.marketAddress?.toLowerCase()||
       quoteSource.expectedMarketCodeHash?.toLowerCase()!==sponsorPolicy.marketCodeHash?.toLowerCase()||
       quoteSource.expectedAssetCodeHash?.toLowerCase()!==sponsorPolicy.assetCodeHash?.toLowerCase()){
      throw new TypeError('quotation contract and authorized sponsor execution contract differ');
    }
    operation=createCustodiedAgentPredictionSettlement({
      ...sponsorPolicy,provider:sponsorProvider,custody,prepareSignedFill,
      independentReceipt:readMarketReceipt,implementation,
    });
  }
  const handle=createAgentPredictionOrderHttpHandler({
    origin:publicOrigin,
    quoteInputs:{...quoteSource,provider:quoteProvider},
    quoteMarket:readMarketQuote,
    ...(operation?{active:true,admitBuyer:buyerMandate,settlementOperation:operation}:{}),
  });
  return Object.freeze({
    fetch:handle,active:operation!==undefined,
    reconcile:()=>operation?operation.reconcile():
      Promise.resolve({status:'read-only-no-transactions'}),
  });
}
