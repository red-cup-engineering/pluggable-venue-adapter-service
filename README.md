# pluggable-venue-adapter-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Venue protocol adapters for financial observations, admitted operations and
unsigned transaction construction. The adapters translate existing authority and
financial contracts into their venue's interface; authority custody, signing,
durable execution and independent settlement retain their existing owners.

| Export | Responsibility |
|---|---|
| `./alpaca` | Account, position, order and activity requests through the injected authority client |
| `./alpaca-broker-admin` | Scoped account administration through the same custody boundary |
| `./kalshi` | Account normalization, exact risk admission and orders through an already credential-bound client |
| `./gmx` | Public contract reads and unsigned, scope-limited transaction plans |
| `./base-spot` | Fixed-block wallet observations, native-to-USDC preparation and the existing execution-custody handoff |
| `./agent-prediction-*` | Quote, payment and settlement interfaces for the existing prediction-market service |

Alpaca, Broker administration, Kalshi and GMX use one internal
[operation snapshot and record contract](specifications/venue-operation-snapshots.md).
Each operation retains one invocation's data across asynchronous provider work.
Identified receipts and unsigned plans are immutable down to their nested values.
A receipt's content identity establishes content integrity; it does not establish
source authentication, a fill, independent reconciliation or earned revenue.

GMX [account valuation](specifications/gmx-account-valuation.md) retains unknown
equity when held collateral cannot be valued. Its
[ABI integer contract](specifications/gmx-abi-integer-values.md) governs calldata
quantities separately from display values. Kalshi's exact financial risk law is
implemented in `src/kalshi-risk-law.mjs`.

Run `npm run check` and `npm test` with the declared suppliers. Tests use fixture
venue responses and local transports. The existing optional Base signer contract
test requires `BASE_SIGNER_MODULE` to select the actual upstream signer; absence
of that selection is reported as a skip, not installed signer qualification.
