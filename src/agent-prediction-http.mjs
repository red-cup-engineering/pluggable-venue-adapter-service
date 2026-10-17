import { readAgentOrderPayment, signedAgentOrderQuoteLocator } from './agent-prediction-x402-v2.mjs';
import { offerAgentOrderFromChain } from './agent-prediction-chain-offer.mjs';

// Domain-owned Fetch interface. The site/web transport remains with its
// existing web-server provider. Nothing here opens a wallet or submits an EVM tx.
const ROUTE = /^\/market\/(0|[1-9][0-9]*)\/asks\/(0|[1-9][0-9]*)\/(quote|buy)$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const MAX_BODY = 4096;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(status, data, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

async function bodyOf(request) {
  const announced = request.headers.get('content-length');
  if (announced !== null && (!/^\d+$/u.test(announced) || Number(announced) > MAX_BODY)) {
    throw new RangeError('order body too large');
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request.body ?? []) {
    length += chunk.byteLength;
    if (length > MAX_BODY) throw new RangeError('order body too large');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input) || !DECIMAL.test(input.lots ?? '')) {
    throw new TypeError('one positive lots quantity is required');
  }
  if (Object.keys(input).length !== 1) throw new TypeError('only lots may be supplied by the buyer');
  return input.lots;
}

/**
 * Native buyer/market machine interface; not a second wallet, ledger, EVM
 * receipt reader, x402 exact facilitator, or ActivityPub identity provider.
 *
 * quoteMarket reads the existing on-chain quote at an authorized source and
 * returns the existing x402 custom 402 challenge. It is injected for offline
 * testing; production uses the source owner offerAgentOrderFromChain.
 *
 * A paid resource is NOT advertised until Operations supplies BOTH a
 * buyer-authorization decision and an idempotent custody-backed settlement
 * operation. 'execute' owns reconciliation, pending/duplicate response and
 * once-only settleAgentOrder dispatch; it must never use direct EVM exact.
 */
export function createAgentPredictionOrderHttpHandler({
  origin, quoteInputs, quoteMarket = offerAgentOrderFromChain,
  admitBuyer, settlementOperation, active = false,
} = {}) {
  const base = new URL(origin);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' ||
        (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new TypeError('order host requires an exact HTTPS or loopback origin');
  }
  if (!quoteInputs || typeof quoteInputs !== 'object' || Array.isArray(quoteInputs) ||
      typeof quoteMarket !== 'function') throw new TypeError('source-owned market quote is required');
  // No paid route is admitted by a caller-controlled flag alone.
  const payable = active === true && typeof admitBuyer === 'function' &&
    settlementOperation && typeof settlementOperation.execute === 'function';
  return async function handle(request) {
    if (!(request instanceof Request)) throw new TypeError('one Fetch Request is required');
    const url = new URL(request.url);
    if (url.origin !== base.origin || url.username || url.password || url.hash) {
      return json(421, { status: 'misdirected_request' });
    }
    const match = ROUTE.exec(url.pathname);
    if (!match || !DECIMAL.test(match[1]) || !DECIMAL.test(match[2])) {
      return json(404, { status: 'route_not_owned' });
    }
    const [, marketId, askId, mode] = match;
    if (mode === 'quote' && request.method !== 'GET' ||
        mode === 'buy' && request.method !== 'POST') {
      return json(405, { status: 'method_not_allowed' }, { allow: mode === 'quote' ? 'GET' : 'POST' });
    }
    let lots;
    if (mode === 'quote') {
      if ([...url.searchParams.keys()].some(k => k !== 'lots') || url.searchParams.getAll('lots').length !== 1) {
        return json(400, { status: 'invalid_quote_arguments' });
      }
      lots = url.searchParams.get('lots');
    } else {
      if (url.search) return json(400, { status: 'invalid_buy_arguments' });
      if (!payable) return json(503, { status: 'market_not_activated', paid: false });
      try { lots = await bodyOf(request); } catch {
        return json(400, { status: 'invalid_buy_body' });
      }
    }
    if (!DECIMAL.test(lots ?? '')) return json(400, { status: 'invalid_lots' });
    const resourceUrl = base.origin + '/market/' + marketId + '/asks/' + askId + '/buy';
    const signature = mode === 'buy' ? request.headers.get('payment-signature') : null;
    let signedLocator;
    if (signature !== null) {
      try { signedLocator = signedAgentOrderQuoteLocator(signature); }
      catch { return json(400, { status: 'payment_signature_refused', paid: false }); }
    }
    let challenge;
    try {
      challenge = await quoteMarket({
        ...quoteInputs, marketId, askId, lots,
        ...(signedLocator ?? {}),
        resource: { url: resourceUrl },
      });
      if (challenge?.status !== 402 || typeof challenge.headers?.['PAYMENT-REQUIRED'] !== 'string') {
        throw new TypeError('quote provider did not produce one x402 challenge');
      }
      const encoded = challenge.headers['PAYMENT-REQUIRED'];
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.accepts?.length !== 1 || decoded.accepts[0]?.extra?.marketId !== marketId ||
          decoded.accepts[0]?.extra?.askId !== askId ||
          decoded.accepts[0]?.extra?.lots !== lots ||
          decoded.resource?.url !== resourceUrl) {
        throw new Error('quote provider did not bind the requested market, order, quantity and resource');
      }
    } catch {
      return signedLocator === undefined
        ? json(503, { status: 'quote_unavailable', paid: false })
        : json(409, { status: 'signed_quote_stale', paid: false, retryPayment: false });
    }
    if (mode === 'quote') {
      // An ordinary information response, never a payable order until active.
      const preview = JSON.parse(Buffer.from(challenge.headers['PAYMENT-REQUIRED'], 'base64').toString('utf8'));
      return json(200, { status: 'read_only_quote', quote: preview.accepts[0],
        payable, paymentEnabled: payable }, { 'x-robots-tag': 'noindex' });
    }
    if (signature === null) {
      return json(402, challenge.body, { 'PAYMENT-REQUIRED': challenge.headers['PAYMENT-REQUIRED'] });
    }
    let instruction;
    try {
      instruction = readAgentOrderPayment(signature, challenge);
    } catch {
      return json(400, { status: 'payment_signature_refused', paid: false });
    }
    let authorized = false;
    try {
      authorized = await admitBuyer({ request, instruction: structuredClone(instruction),
        marketId, askId, lots });
    } catch {
      authorized = false;
    }
    if (authorized !== true) return json(403, { status: 'buyer_mandate_refused', paid: false });
    try {
      const result = await settlementOperation.execute({
        instruction, paymentSignatureHeader: signature, challenge,
        marketId, askId, lots,
      });
      if (result?.status !== 200 && result?.status !== 202) {
        throw new TypeError('custody owner did not return a legitimate order state');
      }
      return json(result.status, result.body);
    } catch {
      // An exception after a possible broadcast MUST NOT invite a second payment.
      return json(202, { status: 'settlement_pending', retryPayment: false });
    }
  };
}
