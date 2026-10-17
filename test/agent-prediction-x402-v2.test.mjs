import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PREDICTION_SCHEME, offerAgentOrder, readAgentOrderPayment, settleAgentOrder,
} from '../src/agent-prediction-x402-v2.mjs';

const nowSeconds = 1_792_000_000;
const ADDR = (d) => '0x' + d.repeat(40);
const NONCE = (d) => '0x' + d.repeat(64);
const SIG = (d) => '0x' + d.repeat(130);
const resource = { url: 'https://market.example/market/12/asks/42/buy', description: 'Purchase outcome shares' };
const requirement = {
  scheme: AGENT_PREDICTION_SCHEME, network: 'eip155:84532',
  amount: '1111000', asset: ADDR('e'), payTo: ADDR('c'), maxTimeoutSeconds: 45,
  extra: {
    paymentFlow: 'upfront', assetTransferMethod: 'eip3009-receive',
    name: 'Synthetic x402 Collateral', version: '2', marketId: '12', askId: '42',
    lots: '2', outcome: 0, unitPrice: '550000', makerAmount: '1100000',
    tradeFee: '11000', providerFee: '4400', protocolFee: '6600',
    provider: ADDR('1'), maker: ADDR('2'), protocolRecipient: ADDR('3'),
    quoteBlock: '125', expiresAt: String(nowSeconds + 60),
    buyIntentEip712Domain: { name: '561 Agent Prediction Market PoC', version: '1' },
  },
};
const PAY = {
  buyIntent: {
    buyer: ADDR('b'), askId: '42', lots: '2', maxTotal: '1111000',
    deadline: String(nowSeconds + 30), nonce: NONCE('4'), paymentNonce: NONCE('5'),
  },
  buySignature: SIG('a'),
  authorization: {
    from: ADDR('b'), to: ADDR('c'), value: '1111000',
    validAfter: String(nowSeconds - 1), validBefore: String(nowSeconds + 40),
    nonce: NONCE('5'), signature: SIG('f'),
  },
};
const encode = (json) => Buffer.from(JSON.stringify(json)).toString('base64');
const clone = (x) => structuredClone(x);
const challenge = () => offerAgentOrder({ resource, requirement, nowSeconds });
const signed = (change = (p) => p) => {
  const offered = challenge();
  const parsed = JSON.parse(Buffer.from(offered.headers['PAYMENT-REQUIRED'], 'base64'));
  return { offered, header: encode(change({ x402Version: 2, resource: parsed.resource,
    accepted: parsed.accepts[0], payload: clone(PAY) })) };
};

function independent(overrides = {}) {
  return {
    finalized: true, transactionStatus: 1, network: requirement.network,
    transactionHash: NONCE('6'), market: requirement.payTo, asset: requirement.asset,
    buyer: PAY.buyIntent.buyer, askId: '42', marketId: '12', lots: '2', outcome: 0,
    paymentNonce: NONCE('5'), buyNonce: NONCE('4'), amount: '1111000',
    maker: ADDR('2'), provider: ADDR('1'), protocolRecipient: ADDR('3'),
    makerAmount: '1100000', providerFee: '4400', protocolFee: '6600',
    authorizationNonceConsumed: true, buyerDebited: true, sharesReceived: true,
    feesSettled: true, backingConserved: true, ...overrides,
  };
}
const submit = (more = {}) => ({ status: 'submitted', transactionHash: NONCE('6'),
  network: requirement.network, buyer: ADDR('b'), ...more });

test('makes one canonical 402 v2 custom scheme challenge', () => {
  const offered = challenge();
  assert.equal(offered.status, 402);
  const body = JSON.parse(Buffer.from(offered.headers['PAYMENT-REQUIRED'], 'base64'));
  assert.equal(body.x402Version, 2);
  assert.deepEqual(body.accepts, [requirement]);
  assert.equal(body.resource.url, resource.url);
  assert.equal(readAgentOrderPayment(signed().header, offered, { nowSeconds }).packet.x402Version, 2);
});

test('refuses incorrect quote, fee conservation, identities and x402 exact substitution', () => {
  const variants = [
    [{ ...requirement, amount: '1111001' }, /arithmetic/u],
    [{ ...requirement, amount: '1.1' }, /atomic-unit/u],
    [{ ...requirement, scheme: 'exact' }, /custom/u],
    [{ ...requirement, network: 'eip155:0' }, /custom/u],
    [{ ...requirement, extra: { ...requirement.extra, assetTransferMethod: 'eip3009' } }, /receiver-only/u],
    [{ ...requirement, extra: { ...requirement.extra, providerFee: '5000' } }, /arithmetic/u],
    [{ ...requirement, extra: { ...requirement.extra, outcome: 3 } }, /outcome/u],
    [{ ...requirement, extra: { ...requirement.extra, maker: '0x1234' } }, /address/u],
    [{ ...requirement, extra: { ...requirement.extra, expiresAt: String(nowSeconds - 1) } }, /expired/u],
  ];
  for (const [quote, rx] of variants) {
    assert.throws(() => offerAgentOrder({ resource, requirement: quote, nowSeconds }), rx);
  }
  assert.throws(
    () => offerAgentOrder({ resource: { url: 'http://market.example/buy' }, requirement, nowSeconds }),
    /HTTPS/u,
  );
});

test('different resource, token, market, order, nonce, payer or signature refuses before paying', () => {
  const changes = [
    p => { p.resource.url += '?t=stolen'; return p; },
    p => { p.accepted.payTo = ADDR('9'); return p; },
    p => { p.accepted.scheme = 'exact'; return p; },
    p => { p.payload.buyIntent.askId = '43'; return p; },
    p => { p.payload.authorization.value = '1111001'; return p; },
    p => { p.payload.authorization.to = ADDR('7'); return p; },
    p => { p.payload.authorization.from = ADDR('7'); return p; },
    p => { p.payload.buyIntent.paymentNonce = NONCE('9'); return p; },
    p => { p.payload.buySignature = ''; return p; },
    p => { p.payload.authorization.validAfter = String(nowSeconds); return p; },
    p => { p.payload.buyIntent.deadline = String(nowSeconds - 1); return p; },
  ];
  for (const change of changes) {
    const { offered, header } = signed(change);
    assert.throws(() => readAgentOrderPayment(header, offered, { nowSeconds }));
  }
});

test('custom facilitator is invoked once and complete independent receipt gates success', async () => {
  const { offered, header } = signed();
  let broadcasts = 0;
  let readbacks = 0;
  const result = await settleAgentOrder({
    challenge: offered, paymentSignatureHeader: header, nowSeconds,
    facilitator: async ({ packet, requirement: terms }) => {
      broadcasts++;
      assert.equal(packet.payload.buyIntent.paymentNonce, packet.payload.authorization.nonce);
      assert.equal(terms.scheme, AGENT_PREDICTION_SCHEME);
      return submit();
    },
    independentReceipt: async ({ transactionHash, expected }) => {
      readbacks++;
      assert.equal(transactionHash, NONCE('6'));
      assert.equal(expected.requirement.extra.marketId, '12');
      return independent();
    },
  });
  assert.equal(broadcasts, 1);
  assert.equal(readbacks, 1);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    status: 'filled', transactionHash: NONCE('6'), network: 'eip155:84532',
    market: ADDR('c'), askId: '42', lots: '2', recipient: ADDR('b'), amount: '1111000',
  });
});

test('uncertain submission never retries or claims failure as final', async () => {
  const { offered, header } = signed();
  let requests = 0;
  let receiving = 0;
  for (const facilitator of [
    async () => { requests++; throw new Error('broadcast timeout'); },
    async () => { requests++; return { status: 'unknown' }; },
    async () => { requests++; return { status: 'pending', transactionHash: NONCE('6') }; },
  ]) {
    const response = await settleAgentOrder({
      challenge: offered, paymentSignatureHeader: header, nowSeconds, facilitator,
      independentReceipt: () => { receiving++; throw new Error('should not poll'); },
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.status, 'settlement_pending');
    assert.equal(response.body.retryPayment, false);
  }
  assert.equal(requests, 3);
  assert.equal(receiving, 0);
});

test('facilitator self-report cannot stand in for independent shares receipt', async () => {
  const { offered, header } = signed();
  const response = await settleAgentOrder({
    challenge: offered, paymentSignatureHeader: header, nowSeconds,
    facilitator: async () => submit(),
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'independent_receiving_pending');
  assert.equal(response.body.retryPayment, false);
});

test('independent receiver outage leaves payment pending, never reposted', async () => {
  const { offered, header } = signed();
  let submissions = 0;
  const response = await settleAgentOrder({
    challenge: offered, paymentSignatureHeader: header, nowSeconds,
    facilitator: async () => { submissions++; return submit(); },
    independentReceipt: async () => { throw new Error('secondary EVM provider unavailable'); },
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.status, 'independent_receiving_pending');
  assert.equal(submissions, 1);
});

test('contradictory readback never fabricates market fill', async () => {
  const { offered, header } = signed();
  for (const receipt of [
    independent({ transactionHash: NONCE('8') }),
    independent({ transactionStatus: 0 }),
    independent({ providerFee: '4401' }),
    independent({ sharesReceived: false }),
    independent({ authorizationNonceConsumed: false }),
    independent({ finalized: true, backingConserved: false }),
    independent({ network: 'eip155:1' }),
    independent({ maker: ADDR('9') }),
  ]) {
    await assert.rejects(settleAgentOrder({
      challenge: offered, paymentSignatureHeader: header, nowSeconds,
      facilitator: async () => submit(), independentReceipt: async () => receipt,
    }), /independent market receipt contradicts/u);
  }
});

test('facilitator cannot rewrite buyer or network', async () => {
  const { offered, header } = signed();
  for (const fault of [
    { network: 'eip155:1' }, { buyer: ADDR('1') },
    { transactionHash: '0x42' }, { status: 'rejected' },
  ]) {
    await assert.rejects(settleAgentOrder({
      challenge: offered, paymentSignatureHeader: header, nowSeconds,
      facilitator: async () => submit(fault),
    }), /facilitator/u);
  }
});

test('oversized or noncanonical base64 cannot reach facilitator', async () => {
  const { offered } = signed();
  for (const header of ['A', 'AAAA\n', 'A'.repeat(100000), encode({ x402Version: 2 })]) {
    let calls = 0;
    await assert.rejects(settleAgentOrder({
      challenge: offered, paymentSignatureHeader: header, nowSeconds,
      facilitator: async () => { calls++; return submit(); },
    }));
    assert.equal(calls, 0);
  }
});
