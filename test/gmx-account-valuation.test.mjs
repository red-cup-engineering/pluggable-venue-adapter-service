import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGmxAccount } from '../src/gmx/model.mjs';

const STABLE = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const position = (overrides = {}) => ({
  market: 'fixture-market', isLong: true, sizeUsd: 25,
  collateralToken: STABLE, collateralAmount: 10_000_000n, ...overrides,
});
const reading = (overrides = {}) => ({
  usdcAmount: 12.34, holdingsUsd: 5, nativeUsd: 0.5,
  stablecoins: [STABLE], positions: [], ...overrides,
});

test('GMX known collateral preserves cash, holdings and the exclusion of gas from equity', () => {
  const input = reading({ positions: [position()], stablecoins: [STABLE.toUpperCase()] });
  const before = structuredClone(input);
  const account = normalizeGmxAccount(input);
  assert.deepEqual(account, {
    cashCents: 1234, freeCashCents: 1234, equityCents: 2734, gasUsd: 0.5,
    positions: [{ market: 'fixture-market', side: 'long', sizeCents: 2500,
      collateralToken: STABLE, collateralCents: 1000 }],
  });
  assert.deepEqual(input, before, 'normalizing an observation must preserve its source');
});

test('GMX held collateral without a USD valuation keeps equity unknown and cash known', () => {
  const input = reading({ positions: [position({ collateralToken: OTHER, collateralAmount: 10n ** 18n })] });
  const before = structuredClone(input);
  const account = normalizeGmxAccount(input);
  assert.equal(account.equityCents, null, 'known cash and holdings cannot complete an unvalued position');
  assert.equal(account.cashCents, 1234);
  assert.equal(account.freeCashCents, 1234);
  assert.equal(account.gasUsd, 0.5);
  assert.deepEqual(account.positions, [{ market: 'fixture-market', side: 'long', sizeCents: 2500,
    collateralToken: OTHER, collateralCents: null }]);
  assert.deepEqual(input, before);
});

test('GMX mixed valued and unvalued collateral cannot publish a known subtotal as total equity', () => {
  const valued = position({ market: 'valued-position' });
  const unvalued = position({ market: 'unvalued-position', isLong: false, collateralToken: OTHER });
  for (const positions of [[valued, unvalued], [unvalued, valued]]) {
    const account = normalizeGmxAccount(reading({ positions }));
    assert.equal(account.equityCents, null);
    assert.equal(account.cashCents, account.freeCashCents);
    assert.equal(account.positions.find(row => row.market === 'valued-position').collateralCents, 1000);
    assert.equal(account.positions.find(row => row.market === 'unvalued-position').collateralCents, null);
  }
});

test('GMX empty and finite nonpositive position views retain the existing known-cash calculation', () => {
  for (const positions of [undefined, [], [position({ sizeUsd: 0, collateralToken: OTHER })],
    [position({ sizeUsd: -25, collateralToken: OTHER })]]) {
    const account = normalizeGmxAccount(reading({ positions }));
    assert.equal(account.equityCents, 1734);
    assert.equal(account.cashCents, 1234);
    assert.equal(account.freeCashCents, 1234);
    assert.deepEqual(account.positions, []);
  }
  assert.deepEqual(normalizeGmxAccount({ usdcAmount: 1 }), {
    cashCents: 100, equityCents: 100, freeCashCents: 100, gasUsd: 0, positions: [],
  });
});

test('GMX refuses invalid supplied position sizes before filtering valued or unvalued collateral', () => {
  const refusesSize = error => error instanceof TypeError && error.message === 'gmx-position-size-required';
  for (const sizeUsd of [NaN, Infinity, -Infinity, undefined, null, '25']) {
    for (const collateralToken of [STABLE, OTHER]) {
      assert.throws(() => normalizeGmxAccount(reading({ positions: [position({ sizeUsd, collateralToken })] })),
        refusesSize, 'sizeUsd=' + String(sizeUsd) + ' must not become a missing position or a numerical account claim');
    }
  }
  for (const row of [null, undefined, {}]) {
    assert.throws(() => normalizeGmxAccount(reading({ positions: [row] })), refusesSize);
  }
});

for (const [field, reason] of [
  ['holdingsUsd', 'gmx-holdings-value-required'],
  ['nativeUsd', 'gmx-native-value-required'],
]) test('GMX refuses invalid supplied ' + field + ' even when collateral is already unknown', () => {
  for (const value of [NaN, Infinity, -Infinity, null, '5']) {
    for (const positions of [[], [position({ collateralToken: OTHER })]]) {
      assert.throws(() => normalizeGmxAccount(reading({ [field]: value, positions })),
        error => error instanceof TypeError && error.message === reason,
        field + '=' + String(value) + ' must not become a numerical account claim');
    }
  }
});

test('GMX refuses nonfinite cent conversions and aggregate overflow', () => {
  const cases = [
    { usdcAmount: Number.MAX_VALUE },
    { holdingsUsd: Number.MAX_VALUE },
    { usdcAmount: Number.MAX_VALUE / 150, holdingsUsd: Number.MAX_VALUE / 150 },
    { positions: [position({ collateralAmount: 10n ** 400n })] },
    { positions: [position({ sizeUsd: Number.MAX_VALUE })] },
    { usdcAmount: Number.MAX_VALUE, positions: [position({ collateralToken: OTHER })] },
  ];
  for (const values of cases) assert.throws(() => normalizeGmxAccount(reading(values)),
    error => error instanceof RangeError && error.message === 'gmx-account-value-out-of-range');
});
