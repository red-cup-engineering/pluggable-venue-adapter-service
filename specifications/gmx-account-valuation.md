# GMX account valuation completeness

`normalizeGmxAccount` projects supplied observations into the existing account
view. It performs no price lookup, venue call, signing or transaction submission.

`cashCents` and `freeCashCents` describe the supplied USDC wallet balance. A held
position (`sizeUsd > 0`) has a numerical `collateralCents` only when its collateral
token is in the caller's `stablecoins` list. The existing conversion assumes six
token decimals and par USD value. Other held collateral retains `null`; it is
unvalued in this projection.

`equityCents` is numerical only when every held position has valued collateral.
It then adds known cash, position collateral and the supplied `holdingsUsd`.
If any held position has `collateralCents: null`, `equityCents` is also `null`.
Consumers must preserve that unknown value instead of treating it as zero or
presenting the known components as complete equity. Known cash and individually
valued positions remain available alongside the unknown total.

`nativeUsd` remains `gasUsd` and is excluded from equity. The existing defaults
remain unchanged: omitted positions are an empty array, and omitted holdings
and native valuations are zero. This function does not establish that a supplied
position view is complete or compute unrealized position profit and loss.

Every supplied position must have a finite JavaScript number as `sizeUsd`,
validated before the held-position filter. Missing, null, string or nonfinite
sizes raise `TypeError('gmx-position-size-required')`, including malformed rows
without a valid size. They cannot disappear through the filter and leave a
numerical equity claim. Finite zero and negative sizes retain the existing
behavior of being excluded from held positions.

Supplied USD values must be finite JavaScript numbers. Invalid cash, holdings
or native values raise their field-specific `TypeError`. Nonfinite cent
conversions, held-position projections or a nonfinite aggregate raise
`RangeError('gmx-account-value-out-of-range')`; no numerical output is `NaN` or
infinity. This remains the existing Number-based display/limit calculation,
with its existing rounding, rather than an exact decimal ledger.

The native regression `test/gmx-account-valuation.test.mjs` covers known and
mixed collateral, preservation of cash and source observations, existing empty
and finite nonpositive position behavior, invalid supplied position sizes,
invalid supplied valuations and overflow. It imports the
original model with the declared Ethers supplier and needs no external service.
