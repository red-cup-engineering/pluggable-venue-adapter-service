import { offerAgentOrder } from './agent-prediction-x402-v2.mjs';

// Exact public getters of AgentPredictionMarketPoC and its fixed-supply asset;
// one numbered EVM block is used for every dependent market and token read.
export const PREDICTION_MARKET_READ_ABI = Object.freeze([
  'function asks(uint256) view returns (uint256 marketId,address maker,address provider,uint8 outcome,uint256 remainingLots,uint256 unitPrice,uint64 expiresAt)',
  'function markets(uint256) view returns (bytes32 rulesDigest,uint64 closesAt,uint8 quorum,uint8 reporterCount,uint8 outcome,bool resolved)',
  'function quoteAsk(uint256,uint256) view returns (uint256 makerAmount,uint256 tradeFee,uint256 providerFee,uint256 protocolFee,uint256 total)',
  'function collateral() view returns (address)',
  'function collateralPerLot() view returns (uint256)',
  'function protocolFeeRecipient() view returns (address)',
]);
export const PREDICTION_COLLATERAL_READ_ABI = Object.freeze([
  'function name() view returns (string)',
  'function version() view returns (string)',
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const ZERO = '0x' + '0'.repeat(40);
const now = () => Math.floor(Date.now() / 1000);

function asAddress(v, label) {
  if (typeof v !== 'string' || !ADDRESS.test(v) || v.toLowerCase() === ZERO) {
    throw new TypeError(label + ' must be a nonzero EVM address');
  }
  return v.toLowerCase();
}
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
function exactUnsigned(value, label, allowZero) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new TypeError(label + ' cannot use unsafe-precision JavaScript numbers');
  }
  if (!(typeof value === 'bigint' || typeof value === 'number' ||
      (typeof value === 'string' && DECIMAL.test(value)))) {
    throw new TypeError(label + ' requires an exact unsigned integer');
  }
  const x = BigInt(value);
  if (x < 0n || x > (1n << 256n) - 1n || (!allowZero && x === 0n)) {
    throw new RangeError(label + ' outside uint256 bounds');
  }
  return x;
}
function positive(v, label) { return exactUnsigned(v, label, false); }
function asUint(v, label) { return exactUnsigned(v, label, true); }
function codePresent(code) {
  return typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/u.test(code)
    && /[1-9a-fA-F]/u.test(code.slice(2));
}
async function call(reader, method, args, blockTag) {
  if (typeof reader?.[method] !== 'function') throw new TypeError('market reader lacks ' + method);
  return reader[method](...args, { blockTag });
}

export async function offerAgentOrderFromChain({
  provider, marketAddress, expectedAsset, expectedRulesDigest, expectedNetwork,
  expectedMarketCodeHash, expectedAssetCodeHash,
  askId, lots, resource, nowSeconds = now(), maxBlockAgeSeconds = 30,
  maxTimeoutSeconds = 45, marketReader, assetReader, computeCodeHash,
  pinnedQuoteBlock, pinnedQuoteBlockHash,
} = {}) {
  if (!provider || typeof provider.getNetwork !== 'function'
      || typeof provider.getBlockNumber !== 'function' || typeof provider.getBlock !== 'function'
      || typeof provider.getCode !== 'function') {
    throw new TypeError('one actual EVM read provider is required');
  }
  const market = asAddress(marketAddress, 'marketAddress');
  const asset = asAddress(expectedAsset, 'expectedAsset');
  if (typeof expectedRulesDigest !== 'string' || !HASH.test(expectedRulesDigest)) {
    throw new TypeError('expectedRulesDigest must be an admitted hash');
  }
  if (!HASH.test(expectedMarketCodeHash ?? '') || !HASH.test(expectedAssetCodeHash ?? '')) {
    throw new TypeError('admitted market and collateral runtime code hashes are required');
  }
  if (typeof expectedNetwork !== 'string' || !/^eip155:[1-9][0-9]*$/u.test(expectedNetwork)) {
    throw new TypeError('expectedNetwork must be pinned CAIP-2');
  }
  const order = positive(askId, 'askId');
  const size = positive(lots, 'lots');
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0
      || !Number.isSafeInteger(maxBlockAgeSeconds) || maxBlockAgeSeconds < 0
      || !Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new TypeError('bounded observation clock and payment timeout are required');
  }
  const network = await provider.getNetwork();
  const actualNetwork = 'eip155:' + BigInt(network.chainId).toString();
  if (actualNetwork !== expectedNetwork) throw new Error('EVM provider chain does not match admitted network');
  const latestBlock = await provider.getBlockNumber();
  if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
    throw new Error('EVM provider returned invalid block height');
  }
  if (pinnedQuoteBlock !== undefined && (!Number.isSafeInteger(pinnedQuoteBlock) ||
      pinnedQuoteBlock < 0 || pinnedQuoteBlock > latestBlock ||
      !HASH.test(pinnedQuoteBlockHash ?? ''))) {
    throw new TypeError('signed quote requires an existing numbered block and its exact hash');
  }
  if (pinnedQuoteBlock === undefined && pinnedQuoteBlockHash !== undefined) {
    throw new TypeError('signed quote block hash cannot be supplied without its block number');
  }
  const blockTag = pinnedQuoteBlock ?? latestBlock;
  const block = await provider.getBlock(blockTag);
  if (pinnedQuoteBlockHash !== undefined &&
      block?.hash?.toLowerCase() !== pinnedQuoteBlockHash.toLowerCase()) {
    throw new Error('signed quote block changed canonical identity');
  }
  if (!block || !Number.isSafeInteger(block.timestamp)
      || block.timestamp > nowSeconds + 15 || nowSeconds - block.timestamp > maxBlockAgeSeconds
      || !HASH.test(block.hash ?? '')) {
    throw new Error('current EVM block is missing, stale, future-dated or unaddressed');
  }
  const [marketCode, tokenCode] = await Promise.all([
    provider.getCode(market, blockTag), provider.getCode(asset, blockTag),
  ]);
  if (!codePresent(marketCode) || !codePresent(tokenCode)) {
    throw new Error('market and collateral token must have bytecode at quoted block');
  }
  const hashCode = computeCodeHash ?? (await import('ethers')).keccak256;
  if (typeof hashCode !== 'function') {
    throw new TypeError('runtime code hashing capability is required');
  }
  const [actualMarketHash, actualAssetHash] = [
    hashCode(marketCode), hashCode(tokenCode),
  ];
  if (actualMarketHash?.toLowerCase() !== expectedMarketCodeHash.toLowerCase()
      || actualAssetHash?.toLowerCase() !== expectedAssetCodeHash.toLowerCase()) {
    throw new Error('deployed market or token runtime bytecode differs from admitted source');
  }
  if (!marketReader || !assetReader) {
    const { Contract } = await import('ethers');
    marketReader ??= new Contract(market, PREDICTION_MARKET_READ_ABI, provider);
    assetReader ??= new Contract(asset, PREDICTION_COLLATERAL_READ_ABI, provider);
  }
  const ask = await call(marketReader, 'asks', [order], blockTag);
  const marketId = positive(ask.marketId, 'marketId');
  if (asAddress(ask.maker, 'maker') === market || asAddress(ask.provider, 'provider') === market
      || positive(ask.remainingLots, 'remainingLots') < size) {
    throw new Error('posted ask has no admissible remaining escrow');
  }
  const state = await call(marketReader, 'markets', [marketId], blockTag);
  if (state.rulesDigest?.toLowerCase() !== expectedRulesDigest.toLowerCase() || state.resolved !== false) {
    throw new Error('market rules differ or market is resolved');
  }
  const expiry = positive(ask.expiresAt, 'ask.expiresAt');
  const close = positive(state.closesAt, 'market.closesAt');
  if (expiry > close || expiry <= BigInt(nowSeconds) || close <= BigInt(nowSeconds)) {
    throw new Error('ask or market is no longer open');
  }
  const collateral = await call(marketReader, 'collateral', [], blockTag);
  if (asAddress(collateral, 'collateral') !== asset) throw new Error('unexpected collateral token');
  const collateralPerLot = positive(
    await call(marketReader, 'collateralPerLot', [], blockTag), 'collateralPerLot',
  );
  const unitPrice = positive(ask.unitPrice, 'ask.unitPrice');
  if (unitPrice > collateralPerLot || ![0, 1, 2].includes(Number(ask.outcome))) {
    throw new Error('ask has invalid price or outcome');
  }
  const [quote, recipient, name, version] = await Promise.all([
    call(marketReader, 'quoteAsk', [order, size], blockTag),
    call(marketReader, 'protocolFeeRecipient', [], blockTag),
    call(assetReader, 'name', [], blockTag),
    call(assetReader, 'version', [], blockTag),
  ]);
  const [makerAmount, tradeFee, providerFee, protocolFee, total] = [
    'makerAmount', 'tradeFee', 'providerFee', 'protocolFee', 'total',
  ].map(key => asUint(quote[key], 'quote.' + key));
  if (makerAmount !== size * unitPrice || providerFee + protocolFee !== tradeFee
      || makerAmount + tradeFee !== total) {
    throw new Error('pinned on-chain quote violates conservation');
  }
  return offerAgentOrder({
    resource,
    nowSeconds,
    requirement: {
      scheme: '561-agent-prediction-order-v1', network: actualNetwork, asset, payTo: market,
      amount: total.toString(), maxTimeoutSeconds,
      extra: {
        paymentFlow: 'upfront', assetTransferMethod: 'eip3009-receive',
        name, version, marketId: marketId.toString(), askId: order.toString(),
        lots: size.toString(), outcome: Number(ask.outcome),
        unitPrice: unitPrice.toString(), makerAmount: makerAmount.toString(),
        tradeFee: tradeFee.toString(), providerFee: providerFee.toString(),
        protocolFee: protocolFee.toString(), provider: asAddress(ask.provider, 'provider'),
        maker: asAddress(ask.maker, 'maker'),
        protocolRecipient: asAddress(recipient, 'protocolRecipient'),
        quoteBlock: String(blockTag), quoteBlockHash: block.hash,
        rulesDigest: state.rulesDigest,
        expiresAt: expiry.toString(),
        buyIntentEip712Domain: { name: '561 Agent Prediction Market PoC', version: '1' },
      },
    },
  });
}
