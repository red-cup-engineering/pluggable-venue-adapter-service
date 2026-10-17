# Agent-prediction order over x402 v2: proposed custom scheme (not exact)

**Owner:** Red Cup Prediction Market Engineering → `pluggable-venue-adapter-service`.  
**Source:** `../src/agent-prediction-x402-v2.mjs` and `../test/agent-prediction-x402-v2.test.mjs`.  
**Status:** technical PoC interface and test vectors; *no* running HTTPS server, facilitator, signer, billing account, testnet or admitted deployment. **Date:** 2026-10-15.

**Rationale.** A machine may pay `0.02 USDC` through ordinary x402 exact for a probabilistic forecast, which grants access to resource bytes. It may then decide to buy `2 YES` positions in a collateralized weather outcome market. These are distinct services, authorities and ledgering events. We **must not** reinterpret a direct EIP-3009 exact payment to a merchant wallet as a valid order book fill.

The upstream protocol's [core v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) specifies extensible schemes, [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and the [EVM exact](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) scheme transfers assets directly to a recipient. This proposed `561-agent-prediction-order-v1` is **not an officially supported x402 scheme** or a claim of x402 interoperability outside its custom facilitator.

## Required owner-supplied read before challenging a buyer

Verify the actual canonical source rules hash; desired `chainId`; market contract address and bytecode; collateral EIP-3009 token, EIP-712 name/version; order existence, maker/provider/outcome; remaining escrow; close and ask expiry; `quoteAsk(askId,lots)` at a recorded chain block; and local authorized customer/provider price/risk policy. Only a fresh, authenticated source of contract state may feed `offerAgentOrder`. The JS function does **not** obtain any of these data itself or independently authenticate them.

**Selected Engineering producer:** `src/agent-prediction-chain-offer.mjs` exports `offerAgentOrderFromChain` and is selected by the package's `./agent-prediction-chain-offer` export. It reads the existing Solidity market's `asks`, `markets`, `quoteAsk`, `collateral`, `collateralPerLot` and `protocolFeeRecipient` at **the same numbered EVM block**, together with collateral-token name/version, chain identity and contract bytecode. It refuses missing bytecode, source-rule mismatch, expired/resolved markets, depleted escrow, stale/future block timestamps, wrong collateral and inconsistent exact-integer fee sums. It returns `offerAgentOrder`'s ordinary custom HTTP 402 challenge, retaining `quoteBlockHash` and `rulesDigest` for the downstream trusted provider/consumer. The caller must establish the actual source bytecode identity, operator resource rights, deployment, local mandate and independently trusted RPC. The read adapter now **requires the accepted deployed runtime code hashes** of both the market and collateral token and rejects any hash mismatch before returning a quote. The current `main` token may have an earlier runtime than the unqualified `PR #1` receiver-only extension; do not confuse a real deployment with a proof of custom EIP-3009 compatibility. No private key or trading permission is acquired by this read-only adapter. The existing package also installs the **read-only** `quote-agent-prediction-order [configuration.json]` command. It accepts the JSON request on stdin or in a named file, uses `PREDICTION_EVM_READ_RPC_URL` only as an operator-chosen HTTPS or loopback RPC read endpoint, and writes the complete 402 challenge as JSON. Its configuration must name `expectedNetwork`, `marketAddress`, `expectedAsset`, `expectedRulesDigest`, **`expectedMarketCodeHash`, `expectedAssetCodeHash`**, `askId`, `lots`, and a canonical HTTPS `resource.url`. It never signs, buys, or broadcasts; its trusted local clock cannot be overridden by an unsigned request. The custom facilitator and actual compatible collateral deployment remain separate. This is a real installed package *entrypoint in source*, not evidence that a buyer-facing HTTP service or an ActivityPub++ Offer is published.

Native entrypoints: `quote-agent-prediction-order` and `serve-agent-prediction-read-only`, with `npm run test:prediction-order` for the focused Node cases and `npm run check:prediction-order`. The latter service consumes the source-owned Fetch application exported as `./agent-prediction-http`; it binds ONLY loopback HTTP while its operator configuration separately pins the canonical HTTPS `publicOrigin`. GET `/market/{marketId}/asks/{askId}/quote?lots=N` returns a read-only quote without a payment-required header. POST `/market/{marketId}/asks/{askId}/buy` refuses with 503 until the already-owning Operations layer injects buyer authorization and durable idempotent signed-EVM custody; only that admitted composition exposes the custom 402. The server never owns a signer or uses standard x402 exact to fill positions. When a signed order follows a block advancement, the accepted `quoteBlock`/`quoteBlockHash` are used ONLY as untrusted locators for a short, canonical re-read; the original signed requirements must still match exactly, or the request refuses without a replay. A proper 200 after independent receiving emits the x402 `PAYMENT-RESPONSE` header; disputed purported fills refuse instead of fabricating settlement. All tests are local synthetic cases, **not production installation, activity federation, or paid performance**.

For an illustrative synthetic quote with token atomic units:

```json
{
  "scheme": "561-agent-prediction-order-v1",
  "network": "eip155:84532",
  "amount": "1111000",
  "asset": "0xefefefefefefefefefefefefefefefefefefefef",
  "payTo": "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "maxTimeoutSeconds": 45,
  "extra": {
    "paymentFlow": "upfront",
    "assetTransferMethod": "eip3009-receive",
    "name": "Synthetic x402 Collateral",
    "version": "2",
    "marketId": "12",
    "askId": "42",
    "lots": "2",
    "outcome": 0,
    "unitPrice": "550000",
    "makerAmount": "1100000",
    "tradeFee": "11000",
    "providerFee": "4400",
    "protocolFee": "6600",
    "provider": "0x1010101010101010101010101010101010101010",
    "maker": "0x2020202020202020202020202020202020202020",
    "protocolRecipient": "0x3030303030303030303030303030303030303030",
    "quoteBlock": "125",
    "quoteBlockHash": "0x8888888888888888888888888888888888888888888888888888888888888888",
    "rulesDigest": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "expiresAt": "1792100000",
    "buyIntentEip712Domain": {
      "name": "561 Agent Prediction Market PoC",
      "version": "1"
    }
  }
}
```

The actual HTTP 402 `PAYMENT-REQUIRED` is a base64-encoded object with `x402Version:2`, `resource`, `accepts:[<requirements>]`. The backend does not invent a sale price—these must match the contract's `quoteAsk` projection. This JS candidate checks that `makerAmount = unitPrice × lots`, `tradeFee = providerFee + protocolFee` and `amount = makerAmount + tradeFee`, without relying on JavaScript floating point money.

## Signed payment envelope

A client independently signs **two cryptographically separate commands**:

- `BuyAsk(buyer,askId,lots,maxTotal,deadline,nonce,paymentNonce)` under EIP-712 `name="561 Agent Prediction Market PoC"`, `version="1"`, verifying `chainId` and `verifyingContract=<market contract>`. The signature binds price limit, order and receiver through domain and contract. `buyIntent.paymentNonce` MUST equal `authorization.nonce`, binding the two independently signed authorizations against facilitator cross-pairing. Never let an agent's untrusted claimed mandate determine its own risk ceiling.
- `ReceiveWithAuthorization(from,to,value,validAfter,validBefore,nonce)` under the collateral token's independent EIP-712 domain. `from=buyer`, `to=market contract`, `value=<exact quoted total>`. This is an EIP-3009 authorization, but its **execution occurs through the custom scheme's market contract**, not standard x402 exact facilitator transfer semantics.

The client sends an x402 v2 `PAYMENT-SIGNATURE` base64 envelope:

```json
{
  "x402Version": 2,
  "resource": "<exact resource object from PAYMENT-REQUIRED>",
  "accepted": "<exact requirements object from PAYMENT-REQUIRED>",
  "payload": {
    "buyIntent": {
      "buyer": "0x...",
      "askId": "42",
      "lots": "2",
      "maxTotal": "1111000",
      "deadline": "1792100000",
      "nonce": "0x...32bytes",
      "paymentNonce": "0x...exact-same-32bytes-as-authorization-nonce"
    },
    "buySignature": "0x...typed-EIP712-signature-bytes",
    "authorization": {
      "from": "0x...buyer",
      "to": "0x...market",
      "value": "1111000",
      "validAfter": "1792099000",
      "validBefore": "1792100000",
      "nonce": "0x...32bytes",
      "signature": "0x...token-EIP3009-signature-bytes"
    }
  }
}
```

Values above are **illustrative**; no example represents usable signed authorization. The custom facilitator must verify both signatures, chain and on-chain token capabilities, simulate `takeAskAuthorized`, then gas-sponsor and submit the **single market call**. If a source contract is upgraded or changes, this version's typed scheme is not silently reinterpreted.

## Exact API: pure interface helpers

`offerAgentOrder({resource,requirement,nowSeconds?})` → `{status:402,headers:{"PAYMENT-REQUIRED":<base64>},body}`. Fails on insecure URLs, ill-typed/wrong-sized amount strings, wrong identities, invalid outcome and inconsistent gross/fees.

`readAgentOrderPayment(header,challenge,{nowSeconds?})` → parsed packet and pinned requirements after validating exact accepted terms, exact resource, integer atomic amount, intended ask/lot/recipient and live validity windows. **It does not validate cryptographic signatures**. The caller's facilitator must.

`settleAgentOrder({paymentSignatureHeader,challenge,facilitator,independentReceipt,nowSeconds?})` → asynchronous machine boundary:
  - Calls the *injected* custom facilitator once. No automatic replay on uncertain payment.
  - Checks successful transaction hash, chain and payer against submitted authority.
  - Calls the *injected* independent chain receiver, which MUST verify actual on-chain status/events and balances from a genuinely independent provider, including the token's consumed EIP-3009 authorization nonce.
  - Returns `200` only on independent matching of expected market, buyer, order, lot, asset, paymentNonce, intentNonce, maker and provider/protocol fees, and all-market backing conservation.
  - Returns `202 settlement_pending` on facilitator uncertainty, or `202 independent_receiving_pending` if the facilitator reports success without an admissible independent receipt. Neither outcome authorizes a repeated charge or claims delivered shares.
  - Rejects bad/mismatched facilitator responses and refused preflight signatures.

The module now exists in the original Engineering owner as `src/agent-prediction-x402-v2.mjs`, exported at `@red-cup-engineering/pluggable-venue-adapter-service/agent-prediction-x402-v2`. The explicit `maker` and `protocolRecipient` requirements carry actual fee-beneficiary identity through to the independent chain receipt; they MUST originate from authenticated on-chain contract/ask state. Caller-supplied `nowSeconds` is for reproducible testing; the default reads current time. Quotes, nonce joins and fee arithmetic are checked as exact `uint256` decimal strings. The syntactic helper does not verify cryptographic signatures and cannot mint, transfer or broadcast anything without an injected custom facilitator. A separate trusted receiver must independently recover finality, transaction status, authorization nonce, share delivery, provider/maker/protocol payouts and backing conservation. Incomplete or uncertain submissions receive 202 without automatic payment retry; a named filled outcome requires a complete consistent receiving record. Initial focused Node tests exercise both normal and adversarial synthetic cases, **not a deployed market**.

These helpers perform **no key reads, on-chain RPC, routing, HTTP listening or delegation by themselves**. A real implementation MUST reuse existing purchased-resource x402 transport, Ethereum signer/bundler authorities and Coesite's independently witnessed receiving, not invent parallel registries or new wallet custody.

## Why this is a market-provider business and not only a betting interface

There are four distinct, independently received revenue possibilities:

1. **Maker-nominated fee beneficiary:** a provider address is immutable per maker ask and gets `providerFee` from the EVM fill in the same transaction. This proves payment to a nominated beneficiary, not actual routing or service. The protocol recipient receives the remainder. These are buyer-visible deterministic integer amounts and **not dependent on the facilitator holding customer funds**.
2. **Maker spread:** a maker owns fully funded contingent inventory and may monetize quoted risk/spread. That requires real fill distribution and forecast calibration; profits are not promised.
3. **x402 information services:** forecasting, raw source data, verification, aggregation, quote search and signal subscriptions can use official x402 `exact`. Existing `x402-exact-purchase-service` implements authorized client purchasing; provider/seller hosting must be independently built and received.
4. **Sponsored execution:** facilitator may offer and price gas/route service, but sponsorship is **not** automatically refunded by the current contract. If a fee is charged for gas, it must be a separate consented line or a properly specified amendment; do not deduct twice.

An agent can be simultaneously a forecaster and a maker but its trade signature must never be treated as proof it is a valid meteorological reporter. Network fees, maker P&L, x402 data fees and sponsor costs stay disjoint in existing enterprise accounting.

## Mandatory receiver-only funding correction and provider economics

**P0: receiver-only source repair is staged, not qualified.** The earlier Solidity market called permissionlessly executable `transferWithAuthorization`, allowing watcher interception without shares. The existing [Ethereum PR #1](https://github.com/red-cup-engineering/ethereum-services-section/pull/1) now contains a source candidate that replaces the sponsored-fill call with `receiveWithAuthorization`, adds that entry point to the existing asset, and adds adversarial Foundry tests (head `fd2b70e`). None of these tests has a compiler/runtime receipt or independent chain receiving. The code remains **unsafe to advertise as a working paid market**, unmerged and not for live funds. EIP-3009 [warns against the original pattern](https://eips.ethereum.org/EIPS/eip-3009#security-considerations); [Ethereum issue #2](https://github.com/red-cup-engineering/ethereum-services-section/issues/2) remains the security admission owner.

**Required corrected semantics:** market must invoke EIP-3009 `receiveWithAuthorization` from its own transaction, and token must implement `ReceiveWithAuthorization` with distinct EIP-712 type hash and `msg.sender == to` validation before consuming authorization. The `main` collateral token still lacks that receiver-only method; the unmerged PR branch adds it as a candidate pending compiler and independent receiver tests. The locally proposed `eip3009-receive` custom scheme must explicitly refuse unsupported tokens/clients; standard `exact/eip3009` consumers continue to use **different** `TransferWithAuthorization` signatures. A normal x402 `exact` facilitator is not a market-filling facilitator.

**Attribution:** maker-nominated `ask.provider` is a payout beneficiary, not proof that the beneficiary delivered the service. If agent R discovers/routes a trade whose ask names P, P earns the on-chain provider share and R does not. Thus the current path is a **maker-linked fee PoC**, not yet an open provider network. The [scientific comparison](https://github.com/lenticule-science/gambling-services-section/blob/research/agent-native-onchain-prediction-20261015/services/prediction-market-science-services-section/docs/2026-10-15-agent-native-onchain-market-research.md) tests maker-nominated, buyer-signed router, and separately charged x402 information-provider alternatives. Provider discovery/qualification remains under Coesite's existing ActivityPub++/OCap/CapTP/A2A capability market. Do not invent a new registry.

**Receiving refusal tests:** direct attacker EOA attempt to consume the exact `ReceiveWithAuthorization` must fail with buyer money and nonce unchanged; authorized market invocation must debit once, issue exact ERC1155 shares and split fees; no cross-chain/token/ask replay; preexisting ordinary x402 exact and allowance-based order paths remain valid. Independent receipt must authenticate original chain/contract/token, consumed *payment* nonce, signed intent nonce, buyer debit, ERC1155 transfer, all maker/provider/treasury payouts, untouched backing and finality. Existing callback assertions do not independently establish these facts. Until actual native-qualified source, tests, and independent receipt exist, HTTP `200 filled` is inadmissible.

## Open integration / compatibility issues

- **Custodied facilitator code exists, live execution does not.** `src/agent-prediction-sponsored-fill.mjs` now composes the exact Solidity `takeAskAuthorized` calldata, two separate signed EIP-712 commands, source codehash checks, market-call simulation, an operator-supplied EIP-1559 sponsor signature, and the existing signed transaction-effect custody. Its EIP-712/broadcast/finality behavior has been exercised only with local injected providers, NOT an installed qualified EVM. The sponsor authority, signed transaction preparer, market codehash and durable custody remain externally selected and may refuse. Ordinary third-party x402 exact facilitators are not compatible just because `paymentFlow:"upfront"` is present.
- **Source-owned independent EVM reader implemented, not installed.** `@red-cup-engineering/ethereum-services-section/agent-prediction-market-receipt` exports `createIndependentAgentPredictionReceipt`. It reads a second original chain source to reconstruct the executed calldata, receiver-only EIP-3009 `AuthorizationUsed`, `AuthorizationTransferExecuted`, exact four ERC20 Transfer effects, `AskFilled`, ERC1155 `TransferSingle`, both consumed nonces, finalized block and global collateral backing. Its local cases are synthetic; it has NOT received an actual market transaction on a deployed chain. Operations must independently select its chain reader, and a separate recorded buyer receiving remains needed.
- **No deployed market.** A working local loopback HTTP quote consumer and an opt-in compositional enterprise `Fetch` runtime now exist under `./agent-prediction-enterprise-runtime`. Local transport tests cover a synthetic HTTP 402 → signed request → custodied transaction → independent reader → HTTP 200 with `PAYMENT-RESPONSE`; no funded chain or real customer was involved. The real HTTPS host, native signer, wallet account, buyer consent, collateral and market deployment, registry installation, Operations policy, rate limiting, ActivityPub++ Offer and independent customer receiving remain absent.
- **No forecast probability/venue-agnostic maker policy.** Reuse existing market-game, binary-maker-game and evidence-filtration/held-out scoring. No disconnected probabilities or a fabricated fee-profit chart.
- **Security gaps:** fraudulent upstream quote, denial-of-service, adversarial calldata, source-clock replay, incompatible ERC-1271 implementation, fee-on-transfer token, reorg/confirmation uncertainty, vulnerable on-chain oracle. Do not use with funds until audited.
- **No real transaction witnesses claimed.** Standalone and composed Node tests exercise mock signatures, EVM reads, source codehash boundaries, durable-custody delegation and genuine loopback HTTP transport. These are not an actual ERC-1271 or EIP-712 crypto test against the deployed Solidity, nor an EVM-chain receipt. Foundry code is a separately staged contract test, and its original runner has not executed compilation.

## Receiving matrix for the first integrated PoC

| Request | Local falsifier | Independent acceptance |
| --- | --- | --- |
| Discover maker price | Reject synthetic mismatched quote arithmetic | Verify `quoteAsk` at pinned block and no slippage under signed cap |
| Agent signs intended trade | Mutate orderId/lot/amount/payer/resource and refuse | EIP-712 verification under pinned contract chain |
| Agent authorizes money | Mutate token recipient, amount, time and refuse | On-chain token nonce consumed once; exact market receipt |
| Sponsor executes | A mock claims success or pending | Real tx destination, calldata, events, fee recipients, source receipt digest |
| Report weather outcome | Different `evidenceDigest` fails quorum | Genuine source bytes/rules are independently received and timestamped |
| Customer receives shares | Without receipt return `202` | Owned ERC1155 balance changes and independently verified ledger |

**Next unreceived effect:** native Solidity security compilation and adversarial transaction execution on a real available EVM runner; pin actual deployed token and market codehashes; commission native transaction-effect custody, independently selected chain receiver and buyer mandate via the original Coesite operations contract. Only then compose the existing source-owned `agent-prediction-enterprise-runtime` and qualified `agent-prediction-market-receipt` in a proper host and publish a real ActivityPub++ capability Offer after acceptance. Do not claim standard x402 interoperability, a paid outcome, or economic profit until actual buyer receiving and settlement.
