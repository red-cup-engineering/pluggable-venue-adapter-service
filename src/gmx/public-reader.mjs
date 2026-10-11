/** Public GMX REST transport. No signer, authority grant, or business records. */
import { GMX_CHAINS } from "../../data/gmx/contracts.mjs";

export function createGmxPublicReader({
  chainId = 42161, baseUrl, fetchImpl = fetch, fetchJson,
  now = () => new Date(), timeoutMs = 15_000,
} = {}) {
  const chain = GMX_CHAINS[chainId];
  if (!chain) throw new RangeError("gmx-chain-unsupported");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError("gmx-timeout-invalid");
  const endpoints = baseUrl ? [baseUrl.replace(/\/$/u, "")] : [chain.api, ...chain.apiFallbacks];
  const load = fetchJson ?? (async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`gmx: ${url} -> HTTP ${response.status}`);
    return response.json();
  });
  async function receive(paths) {
    const failures = [];
    for (const endpoint of endpoints) {
      try {
        // Receive the complete snapshot from one deployment endpoint.
        const rows = await Promise.all(paths.map(async (path) => {
          const url = `${endpoint}${path}`;
          return { url, body: await load(url) };
        }));
        return { endpoint, rows, failures };
      } catch (error) {
        failures.push({ endpoint, error: String(error.message ?? error) });
      }
    }
    throw new AggregateError(failures.map((f) => new Error(`${f.endpoint}: ${f.error}`)), "gmx-public-endpoints-exhausted");
  }
  return Object.freeze({
    chain,
    async get(path) {
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new TypeError("gmx-api-path-invalid");
      const { rows, failures } = await receive([path]);
      return { ...rows[0], failures };
    },
    async fetchMarketSnapshot(coins) {
      const fetchedAt = now().toISOString();
      const { endpoint, rows, failures } = await receive(["/markets/info", "/prices/tickers", "/tokens"]);
      const [marketsInfo, tickers, tokens] = rows.map((row) => row.body);
      if (!Array.isArray(marketsInfo?.markets) || !Array.isArray(tickers) || !Array.isArray(tokens?.tokens)) throw new TypeError("gmx-market-snapshot-shape-invalid");
      return { venue: "gmx", chainId, fetchedAt, coins, marketsInfo, tickers, tokens, sourceBaseUrl: endpoint, failures };
    },
  });
}
