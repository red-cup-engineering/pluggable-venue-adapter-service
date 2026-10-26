import { semanticIdOf } from '@red-cup-engineering/computer-data-engineering-services-section/semiotic-expression-notation/semantic-content-identity';

const semanticId = semanticIdOf('brokerage.pluggable-venue-adapter.record');

/**
 * One invocation owns one copy of its data. Keep optional undefined members and
 * exact BigInt calldata inputs; do not JSON-round-trip, freeze a caller's data,
 * invoke accessors, or silently turn a class, Date or Map into a plain record.
 * Financial value validation and credential rules remain with each adapter.
 */
export function snapshotVenueData(value) {
  const states = new Map();
  const pending = [{value, exit:false}];
  while (pending.length) {
    const current = pending.pop();
    const node = current.value;
    if (node === null || node === undefined || ['string','number','boolean','bigint'].includes(typeof node)) continue;
    if (typeof node !== 'object') throw new TypeError('plain-venue-data-required');
    if (current.exit) { states.set(node,2); continue; }
    if (states.get(node) === 1) throw new TypeError('cyclic-venue-data-refused');
    if (states.get(node) === 2) continue;
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if ((!array && prototype !== Object.prototype && prototype !== null)
      || (array && prototype !== Array.prototype)
      || Object.getOwnPropertySymbols(node).length)
      throw new TypeError('plain-venue-data-required');
    const descriptors = Object.getOwnPropertyDescriptors(node);
    if (array && Object.keys(descriptors).length !== node.length + 1)
      throw new TypeError('dense-venue-data-array-required');
    states.set(node,1);
    pending.push({value:node,exit:true});
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')
        || (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= node.length)))
        throw new TypeError('plain-venue-data-required');
      pending.push({value:descriptor.value,exit:false});
    }
  }
  const copy = structuredClone(value);
  const unfinished = [copy], frozen = new Set();
  while (unfinished.length) {
    const node = unfinished.pop();
    if (!node || typeof node !== 'object' || frozen.has(node)) continue;
    frozen.add(node);
    for (const member of Object.values(node)) unfinished.push(member);
    Object.freeze(node);
  }
  return copy;
}

/** Identify the exact retained snapshot under the original venue record law. */
export function identifyVenueRecord(body, identify = semanticId) {
  const retained = snapshotVenueData(body);
  return Object.freeze({id:identify(retained), ...retained});
}

/** Capture at public entry, before parameter destructuring can invoke getters. */
const asyncFunctionPrototype = Object.getPrototypeOf(async () => {});
export function captureVenueOperations(operations) {
  return Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, operation]) => {
    if (typeof operation !== 'function') return [name,operation];
    const invoke = input => operation(snapshotVenueData(input),input);
    // Preserve each original entry's synchronous throws or rejected promises.
    return [name,Object.getPrototypeOf(operation) === asyncFunctionPrototype
      ? async input => invoke(input) : invoke];
  })));
}
