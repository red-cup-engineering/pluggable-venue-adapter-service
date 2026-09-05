import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";

const semanticId = (value) => identifyJsonSemanticContent({ objectKind: "brokerage.pluggable-venue-adapter.record", value, witnessRoot: EMPTY_WITNESS_ROOT }).id;
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const identify = (body) => ({ id: semanticId(body), ...body });
const CREDENTIAL = /^(authorization|api[-_]?key|api[-_]?secret|secret|token|access[-_]?token|refresh[-_]?token|private[-_]?key|password)$/iu;
function rejectCredentials(value, seen = new Set()) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); for (const [key, member] of Object.entries(value)) { if (CREDENTIAL.test(key)) throw new TypeError("credential-bearing-broker-administration-request-refused"); rejectCredentials(member, seen); } }
function admit(grant, scope, now) { if (grant?.type !== "RevocableBrokerageAuthorityGrant" || grant.adapter !== "alpaca-broker" || grant.revoked === true) throw new TypeError("alpaca-broker-authority-required"); if (!grant.scopes?.includes(scope) || Date.parse(now) >= Date.parse(grant.validUntil)) throw new TypeError("alpaca-broker-administration-scope-refused"); }

export function createAlpacaBrokerAdministrator({ baseUrl = "https://broker-api.alpaca.markets", authorityClient }) {
  if (typeof authorityClient?.authorizedRequest !== "function") throw new TypeError("authority-custody-client-required");
  const call = async ({ grant, scope, method, path, body, now = new Date().toISOString() }) => {
    admit(grant, scope, now); rejectCredentials(body);
    const response = await authorityClient.authorizedRequest({ credentialReference: grant.credentialReference, product: "alpaca-broker", scope, method, url: new URL(path, baseUrl).toString(), body });
    const record = { type: "AlpacaBrokerAdministrationReceipt", version: 1, grant: grant.id, scope, method, path,
      status: response.status, venueRequestId: response.headers?.["x-request-id"] ?? null, payload: response.body,
      authorityCustodyReceipt: response.authorityCustodyReceipt, observedAt: now, strategyAuthority: false, customerAssetOwnership: false, credentialsExported: false };
    return Object.freeze(identify(record));
  };
  return Object.freeze({
    createAccount: ({ grant, application, now }) => call({ grant, scope: "accounts:create", method: "POST", path: "/v1/accounts", body: application, now }),
    getAccount: ({ grant, accountId, now }) => call({ grant, scope: "accounts:read", method: "GET", path: `/v1/accounts/${encodeURIComponent(accountId)}`, now }),
    updateAccount: ({ grant, accountId, patch, now }) => call({ grant, scope: "accounts:update", method: "PATCH", path: `/v1/accounts/${encodeURIComponent(accountId)}`, body: patch, now }),
    uploadDocument: ({ grant, accountId, document, now }) => call({ grant, scope: "documents:write", method: "POST", path: `/v1/accounts/${encodeURIComponent(accountId)}/documents`, body: document, now }),
    listFundingWallets: ({ grant, accountId, now }) => call({ grant, scope: "wallets:read", method: "GET", path: `/v1/accounts/${encodeURIComponent(accountId)}/wallets`, now }),
  });
}
