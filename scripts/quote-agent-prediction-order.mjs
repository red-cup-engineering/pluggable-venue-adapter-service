#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { offerAgentOrderFromChain } from '../src/agent-prediction-chain-offer.mjs';

const MAX_INPUT_BYTES = 65536;

async function readStdin(input) {
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) throw new RangeError('quote input exceeds 64 KiB');
    chunks.push(bytes);
  }
  if (length === 0) throw new TypeError('supply a quote configuration on stdin or by file');
  return Buffer.concat(chunks).toString('utf8');
}

function readRpcUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('PREDICTION_EVM_READ_RPC_URL is required');
  }
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash || !(
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))
  )) throw new TypeError('read-only RPC must be HTTPS or loopback HTTP without embedded credentials or fragment');
  return parsed.href;
}

export async function quoteMarketChallenge(configuration, {
  provider, marketReader, assetReader, computeCodeHash,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError('quote configuration must be an object');
  }
  // Never let an unsigned request rewind the operator's current clock.
  const { nowSeconds: ignoredCallerClock, ...inputs } = configuration;
  void ignoredCallerClock;
  const result = await offerAgentOrderFromChain({
    ...inputs, provider, marketReader, assetReader, computeCodeHash, nowSeconds,
  });
  return Object.freeze({ status: result.status, headers: result.headers, body: result.body });
}

export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length > 1) throw new TypeError('usage: quote-agent-prediction-order [configuration.json]');
  const rpcUrl = readRpcUrl((options.env ?? process.env).PREDICTION_EVM_READ_RPC_URL);
  const source = argv[0] === undefined
    ? await readStdin(options.stdin ?? process.stdin)
    : await readFile(resolve(argv[0]), 'utf8');
  if (Buffer.byteLength(source) > MAX_INPUT_BYTES) throw new RangeError('quote input exceeds 64 KiB');
  const input = JSON.parse(source);
  const openProvider = options.openProvider ?? (async (url) => {
    const { JsonRpcProvider } = await import('ethers');
    return new JsonRpcProvider(url);
  });
  const provider = await openProvider(rpcUrl);
  const response = await quoteMarketChallenge(input, {
    provider, marketReader: options.marketReader, assetReader: options.assetReader,
    computeCodeHash: options.computeCodeHash, nowSeconds: options.nowSeconds,
  });
  (options.stdout ?? process.stdout).write(JSON.stringify(response) + '\n');
  return response;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
