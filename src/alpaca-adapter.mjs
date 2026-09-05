import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";

const semanticId = (value) => identifyJsonSemanticContent({ objectKind: "brokerage.pluggable-venue-adapter.record", value, witnessRoot: EMPTY_WITNESS_ROOT }).id;
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const identify = (body) => ({ id: semanticId(body), ...body });
const CREDENTIAL_FIELDS = new Set(["authorization", "apikey", "apikeyid", "apisecret", "clientid", "clientsecret", "secret", "token", "accesstoken", "refreshtoken", "privatekey", "password"]);
const credentialField = (key) => { const normalized = String(key).toLowerCase().replace(/[-_\s]/gu, ""); return [...CREDENTIAL_FIELDS, "apisecretkey"].some((suffix) => normalized === suffix || normalized.endsWith(suffix)); };
function rejectCredentials(value, seen = new Set()) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); for (const [key, member] of Object.entries(value)) { if (credentialField(key)) throw new TypeError("credential-bearing-venue-request-refused"); rejectCredentials(member, seen); } }
function admit(grant, scope, operation, now) { rejectCredentials(operation); const at = Date.parse(now), expiry = Date.parse(grant?.validUntil); if (!Number.isFinite(at) || !Number.isFinite(expiry)) throw new TypeError("authority-time-invalid"); if (grant?.type !== "RevocableBrokerageAuthorityGrant" || grant.revoked === true) throw new TypeError("current-authority-grant-required"); if (at >= expiry) throw new TypeError("authority-expired"); if (!grant.scopes?.includes(scope)) throw new TypeError("venue-operation-scope-refused"); return grant; }
function clean(value, seen = new Set()) { if (!value || typeof value !== "object") return value; if (seen.has(value)) return null; seen.add(value); if (Array.isArray(value)) return value.map((member) => clean(member, seen)); return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialField(key)).map(([key, member]) => [key, clean(member, seen)])); }

export function createAlpacaAdapter({ product, baseUrl, authorityClient }) {
  if (!["alpaca-connect", "alpaca-broker", "alpaca-trading-paper", "alpaca-trading-live"].includes(product) || typeof authorityClient?.authorizedRequest !== "function") throw new TypeError("alpaca-adapter-configuration-invalid");
  let origin; try { origin = new URL(baseUrl); } catch { throw new TypeError("alpaca-adapter-base-url-invalid"); }
  if (product === "alpaca-trading-paper" && (origin.protocol !== "https:" || origin.hostname !== "paper-api.alpaca.markets" || origin.port !== "" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)) throw new TypeError("paper-trading-base-url-refused");
  if (product === "alpaca-trading-live" && (origin.protocol !== "https:" || origin.hostname !== "api.alpaca.markets" || origin.port !== "" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)) throw new TypeError("live-trading-base-url-refused");
  const call = async ({ grant, observationAuthorization, scope, method, path, body, operationAuthorizationReference, now = new Date().toISOString() }) => {
    if (product === "alpaca-trading-paper" && !observationAuthorization && grant?.adapter !== "alpaca-trading-paper") throw new TypeError("paper-trading-authority-required");
    if (product === "alpaca-trading-live" && grant?.adapter !== "alpaca-trading-live") throw new TypeError("live-trading-authority-required");
    if (observationAuthorization) {
      if (product !== "alpaca-trading-paper" || !["account:read", "positions:read"].includes(scope) || observationAuthorization.type !== "PrincipalPaperAccountObservationAuthorization" || observationAuthorization.venue !== "alpaca-trading-paper") throw new TypeError("paper-observation-authorization-refused");
    } else admit(grant, scope, { method, path, body }, now);
    const authority = observationAuthorization ? { observationAuthorizationReference: observationAuthorization.id } : ["alpaca-trading-paper", "alpaca-trading-live"].includes(product) ? { authorityGrantReference: grant.id, ...(operationAuthorizationReference ? { operationAuthorizationReference } : {}) } : { credentialReference: grant.credentialReference, scope };
    const response = await authorityClient.authorizedRequest({ ...authority, product, method, url: new URL(path, baseUrl).toString(), body });
    if (!Number.isInteger(response?.status)) throw new TypeError("venue-response-invalid");
    const receiptBody = { type: "AlpacaVenueOperationReceipt", version: 1, product, grant: grant?.id ?? observationAuthorization.id, scope, method, path,
      status: response.status, venueRequestId: response.headers?.["x-request-id"] ?? null, observedAt: now, payload: clean(response.body),
      credentialsExported: false, authorityCustodyReceipt: response.authorityCustodyReceipt };
    return Object.freeze(identify(receiptBody));
  };
  return Object.freeze({
    readAccount: ({ grant, observationAuthorization, now }) => call({ grant, observationAuthorization, scope: "account:read", method: "GET", path: product === "alpaca-broker" ? `/v1/trading/accounts/${encodeURIComponent(grant.accountReference)}/account` : "/v2/account", now }),
    listPositions: ({ grant, observationAuthorization, now }) => call({ grant, observationAuthorization, scope: "positions:read", method: "GET", path: product === "alpaca-broker" ? `/v1/trading/accounts/${encodeURIComponent(grant.accountReference)}/positions` : "/v2/positions", now }),
    getOrderByClientOrderId: ({ grant, clientOrderId, now }) => {
      if (typeof clientOrderId !== "string" || clientOrderId.length === 0 || clientOrderId.length > 128) throw new TypeError("client-order-id-required");
      return call({ grant, scope: "orders:read", method: "GET", path: `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, now });
    },
    listActivities: ({ grant, activityType = "FILL", now }) => call({ grant, scope: "activities:read", method: "GET", path: `/v2/account/activities?activity_types=${encodeURIComponent(activityType)}`, now }),
    listCryptoWallets: ({ grant, now }) => call({ grant, scope: "wallets:read", method: "GET", path: `/v1/accounts/${encodeURIComponent(grant.accountReference)}/wallets`, now }),
    placeOrder: ({ grant, order, operationAuthorizationReference, now }) => call({ grant, scope: product === "alpaca-trading-paper" ? "orders:paper" : "orders:live", method: "POST", path: product === "alpaca-broker" ? `/v1/trading/accounts/${encodeURIComponent(grant.accountReference)}/orders` : "/v2/orders", body: order, operationAuthorizationReference, now }),
    cancelOrder: ({ grant, orderId, operationAuthorizationReference, now }) => {
      if (!["alpaca-trading-paper", "alpaca-trading-live"].includes(product)) throw new TypeError("trading-order-cancellation-only");
      if (typeof orderId !== "string" || orderId.length === 0) throw new TypeError("order-id-required");
      return call({ grant, scope: product === "alpaca-trading-paper" ? "orders:paper" : "orders:live", method: "DELETE", path: `/v2/orders/${encodeURIComponent(orderId)}`, operationAuthorizationReference, now });
    },
  });
}
