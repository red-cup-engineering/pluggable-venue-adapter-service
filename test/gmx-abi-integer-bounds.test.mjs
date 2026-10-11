import assert from 'node:assert/strict';
import test from 'node:test';
import { createGmxAdapter, encode, GMX_CHAINS, requiredAllowedContracts, usdToE30 } from '../src/gmx-adapter.mjs';

const word = (value) => BigInt.asUintN(256, value).toString(16).padStart(64, '0');

test('GMX ABI integers preserve each Solidity width at its exact boundaries', () => {
  for (let bits = 8; bits <= 256; bits += 8) {
    const unsignedMax = (1n << BigInt(bits)) - 1n;
    const signedMax = (1n << BigInt(bits - 1)) - 1n;
    const signedMin = -(1n << BigInt(bits - 1));
    assert.equal(encode([`uint${bits}`], [unsignedMax]), word(unsignedMax));
    assert.equal(encode([`int${bits}`], [signedMin]), word(signedMin));
    assert.equal(encode([`int${bits}`], [signedMax]), word(signedMax));
  }
  assert.equal(encode(['uint', 'int'], ['123', '-123']), word(123n) + word(-123n));
});

test('GMX ABI refuses integer overflow instead of wrapping calldata modulo 2^256', () => {
  for (let bits = 8; bits <= 256; bits += 8) {
    assert.throws(() => encode([`uint${bits}`], [1n << BigInt(bits)]), /abi-integer-out-of-range/);
    assert.throws(() => encode([`int${bits}`], [1n << BigInt(bits - 1)]), /abi-integer-out-of-range/);
    assert.throws(() => encode([`int${bits}`], [-(1n << BigInt(bits - 1)) - 1n]), /abi-integer-out-of-range/);
    assert.throws(() => encode([`uint${bits}`], [-1n]), /uint-negative/);
  }
  assert.throws(() => encode(['uint'], [1n << 256n]), /abi-integer-out-of-range/);
  assert.throws(() => encode(['int'], [1n << 255n]), /abi-integer-out-of-range/);
});

test('GMX ABI rejects invalid Solidity integer widths', () => {
  for (const type of ['uint0', 'int0', 'uint1', 'int7', 'uint9', 'int255', 'uint257', 'int512', 'uint08', 'int0256']) {
    assert.throws(() => encode([type], [0n]), /abi-integer-width-invalid/);
  }
});

test('GMX ABI requires exact integer inputs without rejecting supported bigint and string values', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => encode(['int256'], [value]), /abi-integer-unsafe-number/);
  }
  assert.equal(encode(['uint256'], [Number.MAX_SAFE_INTEGER]), word(BigInt(Number.MAX_SAFE_INTEGER)));
  assert.equal(encode(['int256'], [Number.MIN_SAFE_INTEGER]), word(BigInt(Number.MIN_SAFE_INTEGER)));
  assert.equal(encode(['uint256'], ['9007199254740993']), word(9007199254740993n));
  assert.equal(encode(['uint256'], ['0x20000000000001']), word(9007199254740993n));
});

test('GMX ABI applies bounds inside nested tuple and array calldata', () => {
  const nested = { tuple: ['uint256', { array: { tuple: ['int8', 'uint8'] } }] };
  assert.throws(() => encode([nested], [[1n, [[0n, 256n]]]]), /abi-integer-out-of-range/);
  assert.throws(() => encode([nested], [[1n, [[-129n, 0n]]]]), /abi-integer-out-of-range/);
});

test('GMX unsigned GLV plans reject overflowing minimum output before querying allowance', async () => {
  const chain = GMX_CHAINS[42161];
  const account = '0x1111111111111111111111111111111111111111';
  const market = '0x2222222222222222222222222222222222222222';
  const glv = '0x3333333333333333333333333333333333333333';
  const calls = [];
  const adapter = createGmxAdapter({ chainId: 42161, rpc: async (request) => { calls.push(request); return `0x${word(0n)}`; } });
  const grant = { type: 'RevocableBrokerageAuthorityGrant', id: 'urn:grant:synthetic-gmx-abi', adapter: 'gmx', chainId: 42161,
    account, validUntil: '2027-01-01T00:00:00Z', scopes: ['deposits:build'],
    limits: { maxValuePerTransactionUsd: 25, allowedContracts: requiredAllowedContracts(42161, { tokens: [chain.usdc] }) } };
  const deposit = { glv, market, initialLongToken: chain.wnt, initialShortToken: chain.usdc,
    shortAmount: 10_000_000n, valueUsd: 10, minGlvTokens: 1n, executionFeeWei: 1n };
  const build = (changes) => adapter.buildGlvDeposit({ grant, now: '2026-10-11T00:00:00Z', deposit: { ...deposit, ...changes } });
  await assert.rejects(build({ minGlvTokens: (1n << 256n) + 1n }), /abi-integer-out-of-range/);
  for (const field of ['minGlvTokens', 'executionFeeWei', 'shortAmount']) {
    await assert.rejects(build({ [field]: Number.MAX_SAFE_INTEGER + 1 }), /abi-integer-unsafe-number/);
  }
  assert.deepEqual(calls, [], 'a malformed unsigned plan must fail before even the injected read transport is called');
});

test('GMX builders do not erase an unsafe Number by converting it to bigint before encoding', async () => {
  const chain = GMX_CHAINS[42161];
  const account = '0x1111111111111111111111111111111111111111';
  const market = '0x2222222222222222222222222222222222222222';
  const glv = '0x3333333333333333333333333333333333333333';
  const calls = [];
  const adapter = createGmxAdapter({ chainId: 42161, rpc: async (request) => { calls.push(request); return `0x${word(0n)}`; } });
  const grant = { type: 'RevocableBrokerageAuthorityGrant', id: 'urn:grant:synthetic-gmx-integers', adapter: 'gmx', chainId: 42161,
    account, validUntil: '2027-01-01T00:00:00Z', scopes: ['orders:build', 'deposits:build'],
    limits: { maxValuePerTransactionUsd: 25, maxLeverage: 3, allowedContracts: requiredAllowedContracts(42161, { tokens: [chain.usdc, glv] }) } };
  const now = '2026-10-11T00:00:00Z';
  const cases = [
    ['buildPerpOrder', 'order', { market, collateralToken: chain.usdc, collateralAmount: 10_000_000n, collateralUsd: 10,
      sizeDeltaUsd: usdToE30(20), isLong: true, acceptablePriceE30: 1n, executionFeeWei: 1n },
    ['sizeDeltaUsd', 'collateralAmount', 'triggerPriceE30', 'acceptablePriceE30', 'executionFeeWei', 'validFromTime']],
    ['buildGmDeposit', 'deposit', { market, initialLongToken: chain.wnt, initialShortToken: chain.usdc,
      shortAmount: 10_000_000n, valueUsd: 10, minMarketTokens: 1n, executionFeeWei: 1n },
    ['longAmount', 'shortAmount', 'minMarketTokens', 'executionFeeWei']],
    ['buildGlvWithdrawal', 'withdrawal', { glv, market, glvAmount: 10n, valueUsd: 10, executionFeeWei: 1n },
    ['glvAmount', 'minLongTokenAmount', 'minShortTokenAmount', 'executionFeeWei']],
  ];
  for (const [method, key, input, fields] of cases) {
    for (const field of fields) {
      await assert.rejects(adapter[method]({ grant, now, [key]: { ...input, [field]: Number.MAX_SAFE_INTEGER + 1 } }), /abi-integer-unsafe-number/, `${method}.${field}`);
    }
  }
  assert.deepEqual(calls, []);
});

test('GM and GLV deposits refuse a negative leg even when the other leg is positive', async () => {
  const chain = GMX_CHAINS[42161];
  const account = '0x1111111111111111111111111111111111111111';
  const market = '0x2222222222222222222222222222222222222222';
  const glv = '0x3333333333333333333333333333333333333333';
  const calls = [];
  const adapter = createGmxAdapter({ chainId: 42161, rpc: async (request) => { calls.push(request); return `0x${word(0n)}`; } });
  const grant = { type: 'RevocableBrokerageAuthorityGrant', id: 'urn:grant:synthetic-gmx-deposit-legs', adapter: 'gmx', chainId: 42161,
    account, validUntil: '2027-01-01T00:00:00Z', scopes: ['deposits:build'],
    limits: { maxValuePerTransactionUsd: 25, allowedContracts: requiredAllowedContracts(42161, { tokens: [chain.usdc, chain.wnt] }) } };
  const base = { glv, market, initialLongToken: chain.wnt, initialShortToken: chain.usdc, valueUsd: 10, executionFeeWei: 1n };
  for (const method of ['buildGmDeposit', 'buildGlvDeposit']) {
    for (const [longAmount, shortAmount] of [[-1n, 1n], [1n, -1n], ['-1', '1'], ['1', '-1'], [-1, 1], [1, -1]]) {
      await assert.rejects(adapter[method]({ grant, now: '2026-10-11T00:00:00Z', deposit: { ...base, longAmount, shortAmount } }), /uint-negative/);
    }
  }
  assert.deepEqual(calls, []);
  for (const method of ['buildGmDeposit', 'buildGlvDeposit']) {
    await assert.rejects(adapter[method]({ grant, now: '2026-10-11T00:00:00Z', deposit: { ...base, longAmount: 0n, shortAmount: 0n } }), /gmx-deposit-amount-required/);
    const plan = await adapter[method]({ grant, now: '2026-10-11T00:00:00Z', deposit: { ...base, longAmount: 0n, shortAmount: 1n } });
    assert.equal(plan.approvals.length, 1);
    assert.equal(plan.approvals[0].token, chain.usdc, 'zero long leg remains omitted');
  }
});
