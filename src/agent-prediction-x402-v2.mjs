import { isDeepStrictEqual } from 'node:util';

// Pure custom-scheme transport boundary, not a standard x402 exact payment,
// enterprise wallet, on-chain receiver, signer or EVM facilitator.
export const AGENT_PREDICTION_SCHEME = '561-agent-prediction-order-v1';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const CAIP2 = /^eip155:[1-9][0-9]*$/u;
const INTEGER = /^(0|[1-9][0-9]*)$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const HEX_SIGNATURE = /^0x(?:[0-9a-fA-F]{2})+$/u;
const UINT256_MAX = (1n << 256n) - 1n;
const MAX_HEADER_BYTES = 48 * 1024;

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object');
  }
  return value;
}

function amount(value, name, allowZero = false) {
  if (typeof value !== 'string' || !(allowZero ? INTEGER : POSITIVE).test(value)) {
    throw new TypeError(name + ' must be a canonical decimal atomic-unit string');
  }
  const integer = BigInt(value);
  if (integer > UINT256_MAX) throw new RangeError(name + ' exceeds uint256');
  return integer;
}

function address(value, name) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) {
    throw new TypeError(name + ' must be an EVM address');
  }
  return value.toLowerCase();
}

function positiveSeconds(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be positive integral seconds');
  }
  return value;
}

function requiredSignature(value, name) {
  if (typeof value !== 'string' || value.length > 8194 || !HEX_SIGNATURE.test(value)) {
    throw new TypeError(name + ' must be bounded EVM signature bytes');
  }
  return value;
}

function nowSeconds(value) {
  const now = value === undefined ? Math.floor(Date.now() / 1000) : value;
  return positiveSeconds(now, 'nowSeconds');
}

function decodeHeader(header, name) {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_HEADER_BYTES * 2
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(header)) {
    throw new TypeError(name + ' must be bounded canonical base64');
  }
  const bytes = Buffer.from(header, 'base64');
  if (bytes.length > MAX_HEADER_BYTES || bytes.toString('base64') !== header) {
    throw new TypeError(name + ' must be canonical base64');
  }
  try {
    return object(JSON.parse(bytes.toString('utf8')), name);
  } catch (error) {
    if (error instanceof TypeError && error.message === name + ' must be an object') throw error;
    throw new TypeError(name + ' must contain JSON');
  }
}

function validResource(resource) {
  object(resource, 'resource');
  const parsed = new URL(resource.url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
      || parsed.href !== resource.url) {
    throw new TypeError('resource URL must be canonical HTTPS without credentials or fragment');
  }
  return structuredClone(resource);
}

function requirement(value, now) {
  const r = object(value, 'requirement');
  if (r.scheme !== AGENT_PREDICTION_SCHEME || !CAIP2.test(r.network ?? '')) {
    throw new TypeError('only the named custom EVM market-order scheme is supported');
  }
  address(r.asset, 'asset');
  address(r.payTo, 'payTo');
  const quoted = amount(r.amount, 'amount');
  positiveSeconds(r.maxTimeoutSeconds, 'maxTimeoutSeconds');
  const e = object(r.extra, 'requirement.extra');
  if (e.paymentFlow !== 'upfront' || e.assetTransferMethod !== 'eip3009-receive') {
    throw new TypeError('custom market fill requires receiver-only EIP-3009');
  }
  if (typeof e.name !== 'string' || !e.name.trim() || typeof e.version !== 'string' || !e.version.trim()) {
    throw new TypeError('pinned collateral EIP-712 identity is required');
  }
  const domain = object(e.buyIntentEip712Domain, 'buy intent domain');
  if (domain.name !== '561 Agent Prediction Market PoC' || domain.version !== '1') {
    throw new TypeError('unexpected buy-intent EIP-712 domain');
  }
  for (const key of ['marketId', 'askId', 'lots', 'quoteBlock']) amount(e[key], key, key === 'quoteBlock');
  for (const key of ['unitPrice', 'makerAmount', 'tradeFee', 'providerFee', 'protocolFee']) {
    amount(e[key], key, key !== 'unitPrice' && key !== 'makerAmount');
  }
  if (![0, 1, 2].includes(e.outcome)) throw new TypeError('invalid market outcome');
  for (const field of ['provider', 'maker', 'protocolRecipient']) address(e[field], field);
  const expiry = amount(e.expiresAt, 'expiresAt');
  if (expiry <= BigInt(now)) throw new RangeError('quoted ask has expired');
  if (BigInt(e.lots) * BigInt(e.unitPrice) !== BigInt(e.makerAmount)
      || BigInt(e.providerFee) + BigInt(e.protocolFee) !== BigInt(e.tradeFee)
      || BigInt(e.makerAmount) + BigInt(e.tradeFee) !== quoted) {
    throw new RangeError('contract quote gross, fee and total arithmetic disagree');
  }
  return structuredClone(r);
}

function openChallenge(source, now) {
  const c = source?.headers?.['PAYMENT-REQUIRED'] !== undefined
    ? decodeHeader(source.headers['PAYMENT-REQUIRED'], 'PAYMENT-REQUIRED')
    : object(source, 'challenge');
  if (c.x402Version !== 2 || !Array.isArray(c.accepts) || c.accepts.length !== 1) {
    throw new TypeError('challenge must contain one custom x402 v2 acceptance');
  }
  return { challenge: c, resource: validResource(c.resource), accepted: requirement(c.accepts[0], now) };
}

export function offerAgentOrder({ resource, requirement: terms, nowSeconds: clock } = {}) {
  const now = nowSeconds(clock);
  const challenge = {
    x402Version: 2, resource: validResource(resource), accepts: [requirement(terms, now)],
  };
  return Object.freeze({
    status: 402,
    headers: Object.freeze({ 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') }),
    body: Object.freeze({ type: 'agent-prediction-order-payment-required', scheme: AGENT_PREDICTION_SCHEME }),
  });
}

// This only checks syntax and exact joins. Signatures, contract capabilities,
// market inventory and independently receivable effects belong to real providers.
export function readAgentOrderPayment(header, sourceChallenge, { nowSeconds: clock } = {}) {
  const now = nowSeconds(clock);
  const { challenge, resource, accepted } = openChallenge(sourceChallenge, now);
  const packet = decodeHeader(header, 'PAYMENT-SIGNATURE');
  if (packet.x402Version !== 2 || !isDeepStrictEqual(packet.resource, resource)
      || !isDeepStrictEqual(packet.accepted, accepted)) {
    throw new TypeError('signed payment envelope does not match the offered resource and terms');
  }
  const payload = object(packet.payload, 'payload');
  const intent = object(payload.buyIntent, 'buyIntent');
  const auth = object(payload.authorization, 'authorization');
  requiredSignature(payload.buySignature, 'buySignature');
  requiredSignature(auth.signature, 'receive authorization signature');
  const buyer = address(intent.buyer, 'buyer');
  if (buyer === '0x' + '0'.repeat(40) || buyer !== address(auth.from, 'authorization payer')) {
    throw new TypeError('buy intent and funding payer disagree');
  }
  if (address(auth.to, 'authorization recipient') !== address(accepted.payTo, 'market')) {
    throw new TypeError('funding must go to the quoted market contract');
  }
  if (amount(intent.askId, 'intent.askId') !== BigInt(accepted.extra.askId)
      || amount(intent.lots, 'intent.lots') !== BigInt(accepted.extra.lots)
      || amount(auth.value, 'authorization.value') !== BigInt(accepted.amount)
      || amount(intent.maxTotal, 'intent.maxTotal') < BigInt(accepted.amount)) {
    throw new TypeError('signed quantity, ask, payment or buyer ceiling disagree with quote');
  }
  if (!HASH.test(intent.nonce ?? '') || !HASH.test(intent.paymentNonce ?? '')
      || !HASH.test(auth.nonce ?? '') || intent.paymentNonce.toLowerCase() !== auth.nonce.toLowerCase()) {
    throw new TypeError('buy intent must bind the exact payment authorization nonce');
  }
  const deadline = amount(intent.deadline, 'intent.deadline');
  const validAfter = amount(auth.validAfter, 'authorization.validAfter', true);
  const validBefore = amount(auth.validBefore, 'authorization.validBefore');
  if (deadline < BigInt(now) || deadline > BigInt(accepted.extra.expiresAt)
      || validAfter >= BigInt(now) || validBefore <= BigInt(now)
      || validBefore > BigInt(now + accepted.maxTimeoutSeconds)) {
    throw new RangeError('signed buy and receiver authorization validity window is not live');
  }
  return Object.freeze({ packet: structuredClone(packet), challenge, requirement: accepted });
}

/** Extract only the bounded untrusted block locator for rebuilding an earlier 402.
 * This never authenticates a payment, source or buyer. Accepted data must be
 * re-read and joined through readAgentOrderPayment before dispatch. */
export function signedAgentOrderQuoteLocator(header) {
  const packet = decodeHeader(header, 'PAYMENT-SIGNATURE');
  const accepted = object(packet.accepted, 'signed accepted requirement');
  const extra = object(accepted.extra, 'signed accepted extra');
  const height = amount(extra.quoteBlock, 'quoteBlock', true);
  if (height > BigInt(Number.MAX_SAFE_INTEGER) || !HASH.test(extra.quoteBlockHash ?? '')) {
    throw new TypeError('signed quote requires one bounded numbered block hash');
  }
  return Object.freeze({
    pinnedQuoteBlock: Number(height),
    pinnedQuoteBlockHash: extra.quoteBlockHash.toLowerCase(),
  });
}

/** One original finalized EVM economic event, NOT a TypedCommitment,
 * customer acceptance or publication authority. Other stages retain custody
 * of the original chain receipt and may cite this coordinate without inventing
 * another payment ledger. */
export function exactMarketFillSourceEvent(value, {network,market,transactionHash}={}) {
  if (value?.type !== 'EvmAgentPredictionAskFilled' || value.event !== 'AskFilled'
      || value.chain !== network || !CAIP2.test(value.chain ?? '')
      || !Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0
      || !Number.isSafeInteger(value.logIndex) || value.logIndex < 0
      || !HASH.test(value.blockHash ?? '') || !HASH.test(value.transactionHash ?? '')
      || !ADDRESS.test(value.emitter ?? '')
      || value.transactionHash.toLowerCase() !== transactionHash?.toLowerCase()
      || value.emitter.toLowerCase() !== market?.toLowerCase()) {
    throw new TypeError('economic fill needs its exact original finalized chain event coordinate');
  }
  return Object.freeze({
    type:'EvmAgentPredictionAskFilled',chain:network,
    blockNumber:value.blockNumber,blockHash:value.blockHash.toLowerCase(),
    transactionHash:value.transactionHash.toLowerCase(),logIndex:value.logIndex,
    emitter:value.emitter.toLowerCase(),event:'AskFilled',
  });
}

function pending(stage, submitted = {}) {
  return Object.freeze({
    status: 202,
    body: Object.freeze({ status: stage, retryPayment: false,
      ...(typeof submitted.transactionHash === 'string' && HASH.test(submitted.transactionHash)
        ? { transactionHash: submitted.transactionHash.toLowerCase() } : {}) }),
  });
}

export async function settleAgentOrder({
  paymentSignatureHeader, challenge, facilitator, independentReceipt, nowSeconds: clock,
} = {}) {
  const verified = readAgentOrderPayment(paymentSignatureHeader, challenge, { nowSeconds: clock });
  if (typeof facilitator !== 'function') throw new TypeError('one custom facilitator must be injected');
  const { packet, requirement: quoted } = verified;
  let submitted;
  try {
    submitted = await facilitator(structuredClone(verified));
  } catch {
    // A broadcast may have happened before the error; never replay the charge.
    return pending('settlement_pending');
  }
  if (submitted?.status === 'pending' || submitted?.status === 'unknown') {
    return pending('settlement_pending', submitted);
  }
  if (submitted?.status !== 'submitted' || !HASH.test(submitted.transactionHash ?? '')
      || submitted.network !== quoted.network
      || address(submitted.buyer, 'facilitator buyer') !== address(packet.payload.buyIntent.buyer, 'buyer')) {
    throw new TypeError('facilitator did not submit the quoted purchase on the correct chain');
  }
  if (typeof independentReceipt !== 'function') return pending('independent_receiving_pending', submitted);
  let observed;
  try {
    observed = await independentReceipt({
      transactionHash: submitted.transactionHash,
      expected: structuredClone(verified),
    });
  } catch {
    return pending('independent_receiving_pending', submitted);
  }
  if (!observed || observed.finalized !== true) return pending('independent_receiving_pending', submitted);
  const e = quoted.extra;
  const intent = packet.payload.buyIntent;
  const auth = packet.payload.authorization;
  const same = observed.transactionStatus === 1
    && observed.network === quoted.network
    && observed.transactionHash?.toLowerCase() === submitted.transactionHash.toLowerCase()
    && observed.market?.toLowerCase() === quoted.payTo.toLowerCase()
    && observed.asset?.toLowerCase() === quoted.asset.toLowerCase()
    && observed.buyer?.toLowerCase() === intent.buyer.toLowerCase()
    && observed.askId === e.askId && observed.marketId === e.marketId
    && observed.lots === e.lots && observed.outcome === e.outcome
    && observed.paymentNonce?.toLowerCase() === auth.nonce.toLowerCase()
    && observed.buyNonce?.toLowerCase() === intent.nonce.toLowerCase()
    && observed.amount === quoted.amount
    && observed.maker?.toLowerCase() === e.maker.toLowerCase()
    && observed.provider?.toLowerCase() === e.provider.toLowerCase()
    && observed.protocolRecipient?.toLowerCase() === e.protocolRecipient.toLowerCase()
    && observed.makerAmount === e.makerAmount
    && observed.providerFee === e.providerFee
    && observed.protocolFee === e.protocolFee
    && observed.authorizationNonceConsumed === true
    && observed.buyerDebited === true
    && observed.sharesReceived === true
    && observed.feesSettled === true
    && observed.backingConserved === true;
  if (!same) throw new Error('independent market receipt contradicts the signed payment, shares or fee accounting');
  let sourceEconomicEvent;
  try {
    sourceEconomicEvent=exactMarketFillSourceEvent(observed.sourceEconomicEvent,{
      network:quoted.network,market:quoted.payTo,transactionHash:submitted.transactionHash,
    });
  } catch {
    throw new Error('independent market receipt lacks original finalized economic event provenance');
  }
  return Object.freeze({
    status: 200,
    body: Object.freeze({ status: 'filled', transactionHash: submitted.transactionHash,
      network: quoted.network, market: quoted.payTo, askId: e.askId, lots: e.lots,
      recipient: intent.buyer, amount: quoted.amount, sourceEconomicEvent }),
  });
}
