# Agent-prediction order over x402 v2: proposed custom scheme (not exact)

**Owner:** Red Cup Prediction Market Engineering → `pluggable-venue-adapter-service`.  
**Source:** `../src/agent-prediction-x402-v2.mjs` and `../test/agent-prediction-x402-v2.test.mjs`.  
**Status:** technical PoC interface and test vectors; *no* running HTTPS server, facilitator, signer, billing account, testnet or admitted deployment. **Date:** 2026-10-15.

**Rationale.** A machine may pay `0.02 USDC` through ordinary x402 exact for a probabilistic forecast, which grants access to resource bytes. It may then decide to buy `2 YES` positions in a collateralized weather outcome market. These are distinct services, authorities and ledgering events. We **must not** reinterpret a direct EIP-3009 exact payment to a merchant wallet as a valid order book fill.

The upstream protocol's [core v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md) specifies extensible schemes, [HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and the [EVM exact](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md) scheme transfers assets directly to a recipient. This proposed `561-agent-prediction-order-v1` is **not an officially supported x402 scheme** or a claim of x402 interoperability outside its custom facilitator.

## Required owner-supplied read before challenging a buyer

Verify the actual canonical source rules hash; desired `chainId`; market contract address and bytecode; collateral EIP-3009 token, EIP-712 name/version; order existence, maker/provider/outcome; remaining escrow; close and ask expiry; `quoteAsk(askId,lots)` at a recorded chain block; and local authorized customer/provider price/risk policy. Only a fresh, authenticated source of contract state may feed `offerAgentOrder`. The JS function does **not** obtain any of these data itself or independently authenticate them.

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
    "quoteBlock": "125",
    "expiresAt": "<market close/ask expiry as integer seconds>",
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

- `BuyAsk(buyer,askId,lots,maxTotal,deadline,nonce)` under EIP-712 `name="561 Agent Prediction Market PoC"`, `version="1"`, verifying `chainId` and `verifyingContract=<market contract>`. The signature binds price limit, order and receiver through domain and contract. Never let an agent's untrusted claimed mandate determine its own risk ceiling.
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
      "nonce": "0x...32bytes"
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

`offerAgentOrder(input)` → `{status:402,headers:{"PAYMENT-REQUIRED":<base64>},body}`. Fails on insecure URLs, ill-typed/wrong-sized amount strings, wrong identities, invalid outcome and inconsistent gross/fees.

`readAgentOrderPayment(header,challenge)` → parsed packet and pinned requirements after validating exact accepted terms, exact resource, integer atomic amount, intended ask/lot/recipient and live validity windows. **It does not validate cryptographic signatures**. The caller's facilitator must.

`settleAgentOrder({paymentSignatureHeader,challenge,facilitator,independentReceipt})` → asynchronous machine boundary:
  - Calls the *injected* custom facilitator once. No automatic replay on uncertain payment.
  - Checks successful transaction hash, chain and payer against submitted authority.
  - Calls the *injected* independent chain receiver, which MUST verify actual on-chain status/events and balances from a genuinely independent provider, including the token's consumed EIP-3009 authorization nonce.
  - Returns `200` only on independent matching of expected market, buyer, order, lot, asset, paymentNonce, intentNonce, maker and provider/protocol fees, and all-market backing conservation.
  - Returns `202 settlement_pending` on facilitator uncertainty, or `202 independent_receiving_pending` if the facilitator reports success without an admissible independent receipt. Neither outcome authorizes a repeated charge or claims delivered shares.
  - Rejects bad/mismatched facilitator responses and refused preflight signatures.

These helpers perform **no key reads, on-chain RPC, routing, HTTP listening or delegation by themselves**. A real implementation MUST reuse existing purchased-resource x402 transport, Ethereum signer/bundler authorities and Coesite's independently witnessed receiving, not invent parallel registries or new wallet custody.

## Why this is a market-provider business and not only a betting interface

There are four distinct, independently received revenue possibilities:

1. **Maker-nominated fee beneficiary:** a provider address is immutable per maker ask and gets `providerFee` from the EVM fill in the same transaction. This proves payment to a nominated beneficiary, not actual routing or service. The protocol recipient receives the remainder. These are buyer-visible deterministic integer amounts and **not dependent on the facilitator holding customer funds**.
2. **Maker spread:** a maker owns fully funded contingent inventory and may monetize quoted risk/spread. That requires real fill distribution and forecast calibration; profits are not promised.
3. **x402 information services:** forecasting, raw source data, verification, aggregation, quote search and signal subscriptions can use official x402 `exact`. Existing `x402-exact-purchase-service` implements authorized client purchasing; provider/seller hosting must be independently built and received.
4. **Sponsored execution:** facilitator may offer and price gas/route service, but sponsorship is **not** automatically refunded by the current contract. If a fee is charged for gas, it must be a separate consented line or a properly specified amendment; do not deduct twice.

An agent can be simultaneously a forecaster and a maker but its trade signature must never be treated as proof it is a valid meteorological reporter. Network fees, maker P&L, x402 data fees and sponsor costs stay disjoint in existing enterprise accounting.

## Mandatory receiver-only funding correction and provider economics

**P0: contract payment can be consumed without fill.** The staged Solidity `AgentPredictionMarketPoC.takeAskAuthorized` currently calls `transferWithAuthorization`, whose existing token allows any watcher to execute the signed transfer directly. The watcher can consume buyer funds and the nonce without issuing shares. EIP-3009 [explicitly warns against this pattern](https://eips.ethereum.org/EIPS/eip-3009#security-considerations). The existing contract and JavaScript candidates are **not safe or conformant** for sponsored market fills. [Ethereum Engineering issue #2](https://github.com/red-cup-engineering/ethereum-services-section/issues/2) owns the exact cross-contract defect.

**Required corrected semantics:** market must invoke EIP-3009 `receiveWithAuthorization` from its own transaction, and token must implement `ReceiveWithAuthorization` with distinct EIP-712 type hash and `msg.sender == to` validation before consuming authorization. The candidate collateral token currently lacks that receiver-only method. The locally proposed `eip3009-receive` custom scheme must explicitly refuse unsupported tokens/clients; standard `exact/eip3009` consumers continue to use **different** `TransferWithAuthorization` signatures. A normal x402 `exact` facilitator is not a market-filling facilitator.

**Attribution:** maker-nominated `ask.provider` is a payout beneficiary, not proof that the beneficiary delivered the service. If agent R discovers/routes a trade whose ask names P, P earns the on-chain provider share and R does not. Thus the current path is a **maker-linked fee PoC**, not yet an open provider network. The [scientific comparison](https://github.com/lenticule-science/gambling-services-section/blob/research/agent-native-onchain-prediction-20261015/services/prediction-market-science-services-section/docs/2026-10-15-agent-native-onchain-market-research.md) tests maker-nominated, buyer-signed router, and separately charged x402 information-provider alternatives. Provider discovery/qualification remains under Coesite's existing ActivityPub++/OCap/CapTP/A2A capability market. Do not invent a new registry.

**Receiving refusal tests:** direct attacker EOA attempt to consume the exact `ReceiveWithAuthorization` must fail with buyer money and nonce unchanged; authorized market invocation must debit once, issue exact ERC1155 shares and split fees; no cross-chain/token/ask replay; preexisting ordinary x402 exact and allowance-based order paths remain valid. Independent receipt must authenticate original chain/contract/token, consumed *payment* nonce, signed intent nonce, buyer debit, ERC1155 transfer, all maker/provider/treasury payouts, untouched backing and finality. Existing callback assertions do not independently establish these facts. Until actual native-qualified source, tests, and independent receipt exist, HTTP `200 filled` is inadmissible.

## Open integration / compatibility issues

- **Custom facilitator is not implemented.** It must register the scheme explicitly and verify/sign/simulate/broadcast the exact `takeAskAuthorized` method through enterprise sovereign accounts. Ordinary third-party x402 exact facilitators are not compatible just because `paymentFlow:"upfront"` is present.
- **Independent on-chain receiver is injected, not implemented.** It must check transaction destination, calldata identity, EIP-3009 `AuthorizationUsed`, `AskFilled`, ERC1155 `TransferSingle`, ERC20 `Transfer`, block finality, correct network/contract and global backing. It cannot just echo a boolean from an HTTP facilitator.
- **No operational service.** Route, DNS, configuration, rate limiting, contract-address/chain discovery, typed provenance, reservations and stable source timestamps are downstream delivery work.
- **No forecast probability/venue-agnostic maker policy.** Reuse existing market-game, binary-maker-game and evidence-filtration/held-out scoring. No disconnected probabilities or a fabricated fee-profit chart.
- **Security gaps:** fraudulent upstream quote, denial-of-service, adversarial calldata, source-clock replay, incompatible ERC-1271 implementation, fee-on-transfer token, reorg/confirmation uncertainty, vulnerable on-chain oracle. Do not use with funds until audited.
- **No transaction witnesses claimed.** Tests exercise deterministic refusal behavior and mocked callbacks, **not** signatures or actual chain execution. Foundry code is a separate staged contract test at the EVM owner.

## Receiving matrix for the first integrated PoC

| Request | Local falsifier | Independent acceptance |
| --- | --- | --- |
| Discover maker price | Reject synthetic mismatched quote arithmetic | Verify `quoteAsk` at pinned block and no slippage under signed cap |
| Agent signs intended trade | Mutate orderId/lot/amount/payer/resource and refuse | EIP-712 verification under pinned contract chain |
| Agent authorizes money | Mutate token recipient, amount, time and refuse | On-chain token nonce consumed once; exact market receipt |
| Sponsor executes | A mock claims success or pending | Real tx destination, calldata, events, fee recipients, source receipt digest |
| Report weather outcome | Different `evidenceDigest` fails quorum | Genuine source bytes/rules are independently received and timestamped |
| Customer receives shares | Without receipt return `202` | Owned ERC1155 balance changes and independently verified ledger |

**Next:** implement the actual facilitator and receipt reader in existing Ethereum/market provider ownership, add wired local-chain tests that exercise both signatures, and qualify subsequent Coesite delivery configuration. Do not claim standard x402 interoperability or a delivered market until then.
