# GMX unsigned-plan integer values

The GMX adapter's shared ethers ABI codec with local integer admission must preserve the integer supplied to an
unsigned transaction plan. An out-of-range amount, price, execution fee or
minimum output must fail; it must never become a different on-chain value by
wrapping modulo 2^256. This applies recursively inside tuples and arrays before
the adapter returns a plan or queries token allowance for that plan.
GM and GLV deposit builders also reject negative token legs before omitting
zero-valued legs; a second positive leg must not hide a malformed negative leg.

The existing `encode` export implements the integer subset of the
[Solidity Contract ABI specification](https://docs.soliditylang.org/en/latest/abi-spec.html#types):

- `uintM` accepts 0 through 2^M - 1
- `intM` accepts -2^(M-1) through 2^(M-1) - 1
- M is a multiple of 8 between 8 and 256, in canonical decimal notation
- `uint` and `int` retain their meaning as aliases for the 256-bit types
- Accepted negative signed integers are sign-extended to a 32-byte ABI word
- Number inputs must be safe integers; use a bigint or integer string for larger
  exact values. Unsafe, fractional or non-finite Number inputs raise
  `abi-integer-unsafe-number`
- Width errors raise `abi-integer-width-invalid`; overflow and signed underflow
  raise `abi-integer-out-of-range`; negative unsigned input retains the existing
  `uint-negative` error

`test/gmx-abi-integer-bounds.test.mjs` covers every valid width, nested calldata,
aliases, malformed widths and the GLV deposit consumer. The consumer regression
uses only synthetic addresses and an injected transport: a minimum GLV output
of 2^256 + 1 must be rejected, rather than encoded as 1. Existing selector and
unsigned-plan golden tests must remain byte-identical for valid values.

This contract concerns integer representation. It does not validate market
quotes, change any mandate or grant, sign or broadcast a transaction, or claim
that a venue or runtime has received the repaired source.

## Capability ownership

`data/gmx/contracts.mjs` and `data/gmx/rewards.mjs` own frozen deployment and ABI
descriptions. `src/gmx/abi.mjs` applies the declared ethers codec and local exact
integer admission. `model.mjs` and `market.mjs` own pure account and collector
normalization. `public-reader.mjs`, `wallet-observation.mjs`, and
`fee-harvest.mjs` own public transport and read preflights. `gmx-adapter.mjs`
composes these under the existing authority-grant and unsigned-plan contract.

The legacy Oracle `/markets/info` endpoint reports annualized E30 funding;
positive funding denotes the side paying. Annual carry cost is borrowing plus
funding. Hourly comparison divides the observed long-side annual cost by 8760,
retaining both sides and raw evidence. Cached REST observations do not establish
a fixed chain block or an execution-capacity guarantee.

A fee preflight reads both accrued WETH fee trackers on one block, verifies the
router's deployed route, simulates, obtains bounded gas, binds the exact unsigned
transaction, and verifies the block's canonical identity. It acquires no key and
sends nothing. The Personal custodian consumer remains a separate effect.

Account position and order reads retain their bounded 0..100 range. A full page
does not establish complete account coverage; wallet observations expose that
limit as an unresolved read. Collector and Personal consumers use the published
shared exports; historical record scripts are evidence rather than source owners.
