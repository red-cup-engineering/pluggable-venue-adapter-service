import assert from 'node:assert/strict';
import test from 'node:test';
import { offerAgentOrderFromChain } from '../src/agent-prediction-chain-offer.mjs';
import { main as quoteCommand } from '../scripts/quote-agent-prediction-order.mjs';

const ADDRESS = (c) => '0x' + c.repeat(40);
const HASH = (c) => '0x' + c.repeat(64);
const NOW = 1792000000;
const RESOURCE = { url: 'https://market.example/market/12/asks/42/buy' };
const history = [];
function fixtures() {
  const provider = {
    getNetwork: async () => ({ chainId: 84532n }),
    getBlockNumber: async () => 125,
    getBlock: async () => ({ timestamp: NOW - 3, hash: HASH('8') }),
    getCode: async (address, block) => {
      history.push(['getCode', address, block]);
      return address === ADDRESS('c') ? '0x60016000' : '0x60026000';
    },
  };
  const marketReader = {
    asks: async (id, { blockTag }) => {
      history.push(['asks', id, blockTag]);
      return {
        marketId: 12n, maker: ADDRESS('2'), provider: ADDRESS('1'), outcome: 0n,
        remainingLots: 4n, unitPrice: 550000n, expiresAt: BigInt(NOW + 60),
      };
    },
    markets: async (id, { blockTag }) => {
      history.push(['markets', id, blockTag]);
      return { rulesDigest: HASH('a'), closesAt: BigInt(NOW + 120), resolved: false };
    },
    collateral: async ({ blockTag }) => {
      history.push(['collateral', blockTag]);
      return ADDRESS('e');
    },
    collateralPerLot: async ({ blockTag }) => {
      history.push(['collateralPerLot', blockTag]);
      return 1000000n;
    },
    protocolFeeRecipient: async ({ blockTag }) => {
      history.push(['protocolFeeRecipient', blockTag]);
      return ADDRESS('3');
    },
    quoteAsk: async (id, lots, { blockTag }) => {
      history.push(['quoteAsk', id, lots, blockTag]);
      return {
        makerAmount: 1100000n, tradeFee: 11000n, providerFee: 4400n,
        protocolFee: 6600n, total: 1111000n,
      };
    },
  };
  const assetReader = {
    name: async ({ blockTag }) => {
      history.push(['tokenName', blockTag]);
      return 'Synthetic x402 Collateral';
    },
    version: async ({ blockTag }) => {
      history.push(['tokenVersion', blockTag]);
      return '2';
    },
  };
  return {
    provider, marketReader, assetReader, resource: RESOURCE,
    marketAddress: ADDRESS('c'), expectedAsset: ADDRESS('e'),
    expectedRulesDigest: HASH('a'), expectedNetwork: 'eip155:84532',
    expectedMarketCodeHash: HASH('6'), expectedAssetCodeHash: HASH('7'),
    computeCodeHash: (code) => code === '0x60016000' ? HASH('6') : HASH('7'),
    askId: '42', lots: '2', nowSeconds: NOW,
  };
}

test('reads real market getter shape at one numbered block and builds 402 offer', async () => {
  history.length = 0;
  const offer = await offerAgentOrderFromChain(fixtures());
  assert.equal(offer.status, 402);
  const parsed = JSON.parse(Buffer.from(offer.headers['PAYMENT-REQUIRED'], 'base64'));
  assert.equal(parsed.accepts[0].amount, '1111000');
  assert.equal(parsed.accepts[0].extra.rulesDigest, HASH('a'));
  assert.equal(parsed.accepts[0].extra.quoteBlock, '125');
  assert.equal(parsed.accepts[0].extra.quoteBlockHash, HASH('8'));
  assert.equal(parsed.accepts[0].extra.maker, ADDRESS('2'));
  assert.equal(parsed.accepts[0].extra.provider, ADDRESS('1'));
  assert.equal(parsed.accepts[0].extra.protocolRecipient, ADDRESS('3'));
  assert.ok(history.length >= 9);
  for (const record of history) assert.equal(record.at(-1), 125, 'no drifting latest-block reads');
});

test('wrong chain, absent contract bytecode, stale block or wrong rules refuse', async () => {
  let f = fixtures();
  f.expectedNetwork = 'eip155:1';
  await assert.rejects(offerAgentOrderFromChain(f), /chain/u);
  f = fixtures();
  f.provider.getCode = async () => '0x';
  await assert.rejects(offerAgentOrderFromChain(f), /bytecode/u);
  f = fixtures();
  f.provider.getBlock = async () => ({ timestamp: NOW - 999, hash: HASH('8') });
  await assert.rejects(offerAgentOrderFromChain(f), /stale/u);
  f = fixtures();
  f.expectedRulesDigest = HASH('b');
  await assert.rejects(offerAgentOrderFromChain(f), /rules/u);
  f = fixtures();
  f.expectedMarketCodeHash = HASH('f');
  await assert.rejects(offerAgentOrderFromChain(f), /runtime bytecode/u);
  f = fixtures();
  f.expectedAssetCodeHash = HASH('f');
  await assert.rejects(offerAgentOrderFromChain(f), /runtime bytecode/u);
});

test('no escrow, resolved or expired market, wrong token or distorted fee quote refuse', async () => {
  let f = fixtures();
  const a = f.marketReader.asks;
  f.marketReader.asks = async (...args) => ({ ...await a(...args), remainingLots: 1n });
  await assert.rejects(offerAgentOrderFromChain(f), /escrow/u);
  f = fixtures();
  const m = f.marketReader.markets;
  f.marketReader.markets = async (...args) => ({ ...await m(...args), resolved: true });
  await assert.rejects(offerAgentOrderFromChain(f), /resolved/u);
  f = fixtures();
  f.nowSeconds = NOW + 70;
  f.provider.getBlock = async () => ({ timestamp: NOW + 69, hash: HASH('8') });
  await assert.rejects(offerAgentOrderFromChain(f), /open/u);
  f = fixtures();
  f.marketReader.collateral = async () => ADDRESS('f');
  await assert.rejects(offerAgentOrderFromChain(f), /collateral/u);
  f = fixtures();
  const q = f.marketReader.quoteAsk;
  f.marketReader.quoteAsk = async (...args) => ({ ...await q(...args), protocolFee: 6601n });
  await assert.rejects(offerAgentOrderFromChain(f), /conservation/u);
});


test('command consumes an authorized read RPC and produces the exact synthetic 402 offer', async () => {
  const { provider, marketReader, assetReader, computeCodeHash, ...configuration } = fixtures();
  const output = [];
  const stdin = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(configuration)); } };
  let opened = 0;
  const response = await quoteCommand([], {
    stdin,
    env: { PREDICTION_EVM_READ_RPC_URL: 'http://127.0.0.1:8545' },
    stdout: { write: data => output.push(data) },
    openProvider: async url => {
      opened++;
      assert.equal(url, 'http://127.0.0.1:8545/');
      return provider;
    },
    marketReader, assetReader, computeCodeHash, nowSeconds: NOW,
  });
  assert.equal(opened, 1);
  assert.equal(response.status, 402);
  assert.equal(output.length, 1);
  const published = JSON.parse(output[0]);
  assert.deepEqual(published, JSON.parse(JSON.stringify(response)));
  const quoted = JSON.parse(Buffer.from(published.headers['PAYMENT-REQUIRED'], 'base64'));
  assert.equal(quoted.accepts[0].extra.quoteBlockHash, HASH('8'));
  assert.equal(quoted.accepts[0].amount, '1111000');
});

test('command refuses foreign/insecure read RPC or an unauthenticated consumer clock', async () => {
  const { provider, marketReader, assetReader, computeCodeHash, ...configuration } = fixtures();
  let attempts = 0;
  const input = () => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(configuration)); } });
  await assert.rejects(quoteCommand([], {
    env: { PREDICTION_EVM_READ_RPC_URL: 'http://rpc.example:8545/' },
    stdin: input(), openProvider: async () => { attempts++; return provider; },
  }), /read-only RPC/u);
  configuration.nowSeconds = NOW - 1000000;
  await assert.rejects(quoteCommand([], {
    env: { PREDICTION_EVM_READ_RPC_URL: 'http://localhost:8545/' },
    stdin: input(),
    openProvider: async () => { attempts++; return provider; },
    marketReader, assetReader, computeCodeHash, nowSeconds: NOW + 70,
  }), /stale/u);
  assert.equal(attempts, 1, 'rejected RPC never creates a provider');
});


test('a signed earlier quote is faithfully re-read at its still-canonical block', async () => {
  const f = fixtures();
  f.provider.getBlockNumber = async () => 126;
  f.provider.getBlock = async height => {
    assert.equal(height, 125);
    return { timestamp: NOW - 3, hash: HASH('8') };
  };
  const offer = await offerAgentOrderFromChain({
    ...f, pinnedQuoteBlock: 125, pinnedQuoteBlockHash: HASH('8'),
  });
  const signedQuote=JSON.parse(Buffer.from(offer.headers['PAYMENT-REQUIRED'],'base64'));
  assert.equal(signedQuote.accepts[0].extra.quoteBlock,'125');
  await assert.rejects(offerAgentOrderFromChain({
    ...f, pinnedQuoteBlock:125,pinnedQuoteBlockHash:HASH('9'),
  }),/canonical identity/u);
  await assert.rejects(offerAgentOrderFromChain({
    ...f, pinnedQuoteBlock:127,pinnedQuoteBlockHash:HASH('8'),
  }),/existing numbered block/u);
});

test('quoted atomic amounts and ask quantities cannot lose precision as JavaScript numbers', async () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 2;
  let f=fixtures();
  f.lots=unsafe;
  await assert.rejects(offerAgentOrderFromChain(f),/unsafe-precision/u);
  f=fixtures();
  f.askId=unsafe;
  await assert.rejects(offerAgentOrderFromChain(f),/unsafe-precision/u);
  f=fixtures();
  const original=f.marketReader.quoteAsk;
  f.marketReader.quoteAsk=async (...args)=>({...await original(...args),total:unsafe});
  await assert.rejects(offerAgentOrderFromChain(f),/unsafe-precision/u);
  f=fixtures();
  const ask=f.marketReader.asks;
  f.marketReader.asks=async (...args)=>({...await ask(...args),unitPrice:'0x86470'});
  await assert.rejects(offerAgentOrderFromChain(f),/exact unsigned integer/u);
});
