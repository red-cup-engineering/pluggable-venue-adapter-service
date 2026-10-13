/**
 * Kalshi's venue-specific risk geometry, computed with exact integer ratios.
 *
 * BigInt carries the *existing* exact-number discipline across the live
 * admission boundary: parsing source decimal digits never passes through a
 * binary64 intermediary. This is NOT another number tower, account ledger,
 * probability estimate, signer, or trading authority.
 *
 * A binary YES contract costs price dollars; a NO contract costs (1-price)
 * dollars. The quantity may be fractional; all reserved risk is rounded UP
 * to whole USD cents. All contract monetary caps are rounded DOWN so a
 * fractional-cent risk allowance cannot authorize an extra cent.
 *
 * Missing, NaN, infinite, unsafe-integer and malformed fields reject, not
 * falsey comparisons. A formally bounded risk check must never return
 * "admit" because an input silently became NaN.
 */
const decimal = (value, field) => {
  if (typeof value === 'number' &&
      (!Number.isFinite(value) ||
       (Number.isInteger(value) && !Number.isSafeInteger(value))))
    throw new TypeError(`${field}-exact-decimal-required`);
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new TypeError(`${field}-exact-decimal-required`);
  const digits = String(value);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/u.exec(digits);
  if (!match || match[2].length > 30 || (match[3]?.length ?? 0) > 18)
    throw new TypeError(`${field}-exact-decimal-required`);
  const denominator = 10n ** BigInt(match[3]?.length ?? 0);
  const numerator = BigInt(match[2] + (match[3] ?? '')) * (match[1] ? -1n : 1n);
  return {numerator, denominator};
};
const nonnegative = (value,field) => {
  const ratio = decimal(value,field);
  if (ratio.numerator < 0n) throw new RangeError(`${field}-negative`);
  return ratio;
};
const centsLimit = (value,field) => {
  const {numerator,denominator}=nonnegative(value,field);
  return (numerator * 100n) / denominator;
};
const safe = (value,label) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError(`${label}-unsafe-integer-cents`);
  return Number(value);
};
const centsField = (value,label,{negative=true}={}) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      (!negative && value < 0))
    throw new TypeError(`${label}-integer-cents-required`);
  return BigInt(value);
};
const ceilPositive = (numerator,denominator) => {
  if (numerator < 0n || denominator <= 0n)
    throw new RangeError('nonnegative-rational-risk-required');
  return (numerator + denominator - 1n) / denominator;
};
const bookSide = side => {
  if (side !== 'bid' && side !== 'ask')
    throw new TypeError('kalshi-book-side-required');
  return side;
};
const price = (value,label) => {
  const q=nonnegative(value,label);
  if (q.numerator > q.denominator)
    throw new RangeError(`${label}-outside-one-dollar`);
  return q;
};
const riskCents = ({count,priceDollars,priceCents,side}) => {
  const q=nonnegative(count,'contract-count');
  const p=priceDollars===undefined
    ?(() => {
      const cents=nonnegative(priceCents,'yes-price-cents');
      if(cents.numerator>100n*cents.denominator)
        throw new RangeError('yes-price-cents-outside-one-dollar');
      return {numerator:cents.numerator,denominator:cents.denominator*100n};
    })()
    :price(priceDollars,'yes-price');
  bookSide(side);
  const numerator=q.numerator * (side==='ask'
    ?p.denominator-p.numerator:p.numerator)*100n;
  const denominator=q.denominator*p.denominator;
  return safe(ceilPositive(numerator,denominator),'kalshi-order-risk');
};

/** Conservative risk of buying this binary market side, in whole cents. */
export const kalshiOrderRiskCents=({count,price,side}={}) => {
  const q=nonnegative(count,'contract-count');
  const p=price===undefined?null:nonnegative(price,'yes-price');
  if(q.numerator*100n < q.denominator || !p ||
     p.numerator<=0n || p.numerator>=p.denominator)
    throw new RangeError('positive-kalshi-order-lot-and-interior-price-required');
  return riskCents({count,priceDollars:price,side});
};

/** Conservative collateral of a resting YES bid or YES ask. */
export function kalshiRestingRiskCents(row) {
  return riskCents({
    count:row?.count,priceDollars:row?.yesPriceDollars,
    priceCents:row?.priceCents,side:row?.bookSide,
  });
}

/** Market exposure is not permitted to under-reserve fractional cents. */
export function kalshiUsdCeilCents(value) {
  const q=nonnegative(value,'market-exposure');
  return safe(ceilPositive(q.numerator*100n,q.denominator),'kalshi-market-exposure');
}

/** The risk contract's admissible caps; amounts are never rounded upward. */
export function kalshiRiskContractBounds(contract) {
  if (contract?.type!=='PrincipalBrokerageServiceContract' ||
      contract.capital?.currency!=='USD' ||
      !contract.risk || typeof contract.risk!=='object' ||
      Array.isArray(contract.risk))
    throw new TypeError('complete-USD-principal-risk-contract-required');
  const capitalCents=centsLimit(contract.capital.amount,'capital');
  if (capitalCents<=0n)
    throw new RangeError('positive-principal-capital-required');
  const risk=contract.risk;
  const limit = nonnegative(risk.concentrationLimit,'concentration-limit');
  if (limit.numerator<=0n || limit.numerator>limit.denominator)
    throw new RangeError('fractional-concentration-limit-required');
  return Object.freeze({
    capitalCents:safe(capitalCents,'kalshi-capital'),
    maximumLossCents:safe(centsLimit(risk.maximumLossAmount,'maximum-loss'),'kalshi-maximum-loss'),
    maximumOrderCents:safe(centsLimit(risk.maximumOrderNotional,'maximum-order'),'kalshi-maximum-order'),
    maximumAggregateCents:safe(centsLimit(risk.maximumAggregateNotional,'maximum-aggregate'),'kalshi-maximum-aggregate'),
    maximumEventCents:safe((capitalCents*limit.numerator)/limit.denominator,'kalshi-concentration'),
  });
}

/** Input-custody validation before comparing portfolio risks. */
export function kalshiAccountRiskInputs(account) {
  if (!account || !Array.isArray(account.positions) ||
      !Array.isArray(account.resting))
    throw new TypeError('complete-observed-kalshi-account-required');
  const equityCents = centsField(account.equityCents,'equity');
  const freeCashCents = centsField(account.freeCashCents,'free-cash');
  const positions=account.positions.map(p=>{
    if (typeof p?.eventTicker!=='string' || !p.eventTicker.trim())
      throw new TypeError('observed-position-event-required');
    return {eventTicker:p.eventTicker,costCents:centsField(p.costCents,'position-cost',{negative:false})};
  });
  const resting=account.resting.map(o=>{
    if (typeof o?.eventTicker!=='string' || !o.eventTicker.trim())
      throw new TypeError('resting-order-event-required');
    return {eventTicker:o.eventTicker,riskCents:BigInt(kalshiRestingRiskCents({
      ...o,count:o.countDecimal??o.count,
    }))};
  });
  return {equityCents,freeCashCents,positions,resting};
}

/** Domain-specific exact book input price, preserving fractional cents. */
export function kalshiPriceCents(value) {
  const p=price(value,'yes-price');
  // A double is only the outward display representation; all risk math uses
  // retained source `yesPriceDollars` instead of this displayed Number.
  return Number(p.numerator*100n)/Number(p.denominator);
}

/** Exact source count is only converted to a Number for display/readability. */
export function kalshiCountNumber(value,{signed=false}={}) {
  const q=signed?decimal(value,'contract-count'):nonnegative(value,'contract-count');
  const magnitude=q.numerator<0n?-q.numerator:q.numerator;
  if(magnitude > BigInt(Number.MAX_SAFE_INTEGER)*q.denominator)
    throw new RangeError('contract-count-exceeds-safe-representation');
  const n=Number(q.numerator)/Number(q.denominator);
  if(!Number.isFinite(n))throw new RangeError('contract-count-nonfinite');
  return n;
}
