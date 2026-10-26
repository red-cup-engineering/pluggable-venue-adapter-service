# Venue operation snapshots and identified records

Serves: requirement:venue-agnostic-trading-core  
Serves: requirement:finance-platformized-with-books-before-revenue-claims

## Receiving scenario

An asynchronous venue operation must describe one invocation. If a caller changes
its grant, account, token list or order while a provider is pending, that change
must not combine one account's native balance with another account's token
balances, change an order that was already admitted, or make a transaction plan's
sender disagree with its approval and retained authority reference. A consumer
must not be able to change the retained transaction or financial evidence while
leaving its content identity unchanged.

## Ownership and representation

`src/venue-record.mjs` owns the internal data snapshot and record construction used
by the Alpaca, Alpaca Broker administration, Kalshi and GMX adapters. Protocol
translation, authority scope, credential policy, financial units and value
validation remain with their existing adapters and suppliers.

The request data carrier contains plain records, dense arrays, strings, booleans,
numbers, null, optional undefined values and the exact BigInt values already used
by the GMX calldata interface. Snapshots preserve undefined and BigInt; a JSON
serialization round trip is not the copy operation. Shared references are allowed
when acyclic. Accessors, hidden/symbol fields, class instances, mutable exotic
containers, functions, sparse arrays and cycles are refused before asynchronous
dispatch. This prevents native structured cloning from silently replacing an
unsupported domain object with a superficially similar record.

Snapshots copy the admitted data and recursively freeze only the copy. Caller
objects remain writable. No request snapshot is itself an authority grant or a
financial valuation. Each adapter still checks the captured values against its
own contract.

Capture occurs at each public operation's entry, before parameter destructuring
or path construction can invoke a caller's accessor. It covers the entire input,
including timestamps and optional operation-authorization references. Original
regular/async function behavior is preserved, including synchronous GMX fee-claim
construction and immediate argument refusals on existing regular methods.

Factory configuration has its own lifetime. Alpaca adapters retain the parsed URL
string used at construction, so mutating a caller-owned URL cannot redirect a
later request after origin validation. GMX retains its configured chain and block
selector as data snapshots. Injected transport/custody functions remain actual
provider capabilities, not copied data.

## Lifetime and authority

- Alpaca and Broker administration capture the grant, optional observation
  authorization and request body before calling the authority client. The
  authority reference recorded after that await is the one used for dispatch.
- GMX reads capture the grant and declared operation data before invoking RPC or
  HTTP suppliers. Every account, token and retained authority reference in the
  operation comes from that snapshot.
- GMX unsigned builders capture grants, orders/deposits/withdrawals and optional
  market decisions before allowance reads. Calldata, approvals, limit checking
  and final plan identification consume that same data. Signing and current
  authority/nonce rechecking remain the custodian's separate responsibility.
- Kalshi preflight and placement capture the grant, principal contract and order
  before observing the account. Before a placement may reach the client, the
  caller's grant and principal contract must still equal those captured values.
  Revocation or other policy drift refuses the write. Order mutation does not
  replace the already captured order. This comparison does not establish a live
  external revocation feed, atomic account observation, or a reservation against
  concurrent orders; those remain separate custody and execution obligations.

Broker administration rejects nonfinite invocation/expiry times before dispatch,
matching the existing temporal admission rule in the sibling adapters. A malformed
expiry must not pass through JavaScript's false comparison with NaN.

## Retained records

The record builder snapshots the body first, computes its identity with the
existing `semanticIdOf('brokerage.pluggable-venue-adapter.record')`, and returns the
immutable retained body with that identity. It introduces no hash scheme, version
change or new public export. The supplier's admitted JSON-to-SEN law still controls
which output values can be identified. Native BigInt request quantities continue
through existing venue codecs into the already established JSON output forms.

All nested transaction, approval, payload and verdict objects are frozen before
return and before a recording callback receives them. The snapshot does not
authenticate a provider, prove an external fill or reconcile an account.

## Verification obligations

The public adapter regression cases pause providers at actual await boundaries,
mutate caller data, and check the final request, retained account/authority,
transaction and approval against the original invocation. Independent identity
checks use the original supplier's semantic ID function over the returned body.
Mutation attempts exercise nested objects and arrays, including a recording
callback. Negative cases require policy drift, invalid authority times and
unsupported input carriers to stop before a financial write. Controls preserve
undefined optionals, exact BigInt calldata inputs and writable caller objects.

The original full affected Kalshi, GMX and canonical-identity suites remain part
of qualification. Fixture transports establish the adapter contract, not a live
venue operation or installed-runtime receiving.
