#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentPredictionOrderHttpHandler } from '../src/agent-prediction-http.mjs';

const MAX_CONFIG = 65536;
const READ_ORIGIN = /^https:$/u;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function trustedRpc(raw) {
  const url = new URL(raw);
  if ((!READ_ORIGIN.test(url.protocol) && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) ||
    url.username || url.password || url.hash) {
    throw new TypeError('read-only JSON-RPC requires credential-free HTTPS or loopback HTTP');
  }
  return url.href;
}

/** Development/diagnostic loopback host for the Fetch market application.
 * Production sites compose createAgentPredictionOrderHttpHandler into the
 * existing web-server runtime, never this bespoke listener. */
export async function serveAgentPredictionReadOnly({
  source, provider, quoteMarket, rpcUrl, openProvider,
  host = '127.0.0.1', port = 0,
} = {}) {
  if (!LOOPBACK.has(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('local quote server only binds an admitted loopback host and port');
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('one operator-supplied market source binding is required');
  }
  const { nowSeconds: ignoredClock, publicOrigin, ...admitted } = source;
  void ignoredClock;
  const publicUrl = new URL(publicOrigin);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
      publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new TypeError('operator source must pin one canonical public HTTPS origin');
  }
  if (!provider) {
    const endpoint = trustedRpc(rpcUrl);
    const create = openProvider ?? (async uri => {
      const { JsonRpcProvider } = await import('ethers');
      return new JsonRpcProvider(uri);
    });
    provider = await create(endpoint);
  }
  let handler;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (typeof incoming.url !== 'string' || !incoming.url.startsWith('/') ||
          incoming.url.startsWith('//')) {
        outgoing.writeHead(421, { 'content-type':'application/json' });
        outgoing.end(JSON.stringify({status:'misdirected_request'}));
        return;
      }
      const request = new Request(handler.origin + incoming.url, {
        method:incoming.method, headers:incoming.headers,
      });
      const result = await handler.fetch(request);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers));
      outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      outgoing.writeHead(503, { 'content-type':'application/json', 'cache-control':'no-store' });
      outgoing.end(JSON.stringify({status:'quote_unavailable',paid:false}));
    }
  });
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, host, done);
    });
    const address = server.address();
    const listenOrigin = 'http://' + host + ':' + address.port;
    handler = {
      origin:publicUrl.origin,
      fetch:createAgentPredictionOrderHttpHandler({
        origin:publicUrl.origin, quoteInputs:{ ...admitted,provider },
        ...(quoteMarket === undefined ? {} : { quoteMarket }),
        active:false,
      }),
    };
    return Object.freeze({ origin:listenOrigin, publicOrigin:publicUrl.origin,
      close:()=>new Promise((done,fail) => server.close(error => error ? fail(error) : done())),
    });
  } catch (error) {server.close();throw error;}
}

export async function main({env=process.env,stdout=process.stdout}={}) {
  if (!env.PREDICTION_QUOTE_CONFIG) throw new TypeError('PREDICTION_QUOTE_CONFIG is required');
  const sourceBytes = await readFile(resolve(env.PREDICTION_QUOTE_CONFIG));
  if (sourceBytes.length === 0 || sourceBytes.length > MAX_CONFIG) throw new RangeError('market source config outside 1-65536 bytes');
  const running = await serveAgentPredictionReadOnly({
    source:JSON.parse(sourceBytes.toString('utf8')),rpcUrl:env.PREDICTION_EVM_READ_RPC_URL,
    host:env.HOST ?? '127.0.0.1',port:Number(env.PORT ?? '15625'),
  });
  stdout.write(JSON.stringify({status:'listening',origin:running.origin,publicOrigin:running.publicOrigin,paid:false})+'\n');
  return running;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{
    process.stderr.write((error instanceof Error ? error.message : String(error))+'\n');
    process.exitCode=1;
  });
}
