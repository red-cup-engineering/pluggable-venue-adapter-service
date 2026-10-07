import { constants } from 'node:fs';
import { mkdir, open, lstat, readFile, rename, link, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Transaction, getAddress } from 'ethers';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quantity = value => {
 if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new TypeError('exact-rpc-quantity-required');
 return BigInt(value);
};
const ni = value => typeof value === 'string' && /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/.test(value);

/** Account serialization uses an OS lock, released on process death. The
 * pending signed bytes outlive that lock. No stale-PID lock stealing or nonce
 * replacement is needed. Callers provide current authority and strategy;
 * this custody primitive never invents them. */
export function createTransactionEffectCustody({ directory, address, chainId, rpc, recordOutcome, clock = () => new Date().toISOString() }) {
 if (!isAbsolute(directory ?? '') || !Number.isSafeInteger(chainId) || chainId <= 0 || typeof rpc !== 'function' || typeof recordOutcome !== 'function') throw new TypeError('transaction-custody-bindings-required');
 address = getAddress(address);
 const pendingPath = join(directory, 'pending.json');
 async function checkPrivate(path, directoryRequired = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directoryRequired ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new TypeError('private-owned-transaction-custody-required');
 }
 async function syncDirectory() { const file = await open(directory, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } }
 async function save(path, value, immutable = false) {
  const bytes = JSON.stringify(value) + '\n', temporary = join(directory, '.' + randomUUID() + '.tmp');
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
   if (immutable) {
    try { await link(temporary, path); } catch (error) { if (error.code !== 'EEXIST' || await readFile(path, 'utf8') !== bytes) throw error; }
    await unlink(temporary);
   } else await rename(temporary, path);
   await syncDirectory();
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
 }
 async function load(path) {
  try { await checkPrivate(path); return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
 }
 async function locked(operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await checkPrivate(directory, true);
  const lockPath = join(directory, 'account.lock');
  const lockFile = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600); await lockFile.close(); await checkPrivate(lockPath);
  const child = spawn('flock', ['--exclusive', '--nonblock', lockPath, process.execPath, '-e', 'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false, lockError = null;
  const finished = new Promise(resolve => { child.once('error', error => { exited = true; lockError = error; resolve(); }); child.once('close', () => { exited = true; resolve(); }); });
  child.stdin.on('error', () => {}); child.stderr.resume();
  try { await new Promise((resolve, reject) => {
   child.once('error', reject);
   child.once('close', () => reject(new TypeError('account-transaction-execution-already-running')));
   child.stdout.once('data', data => data.toString() === 'locked\n' ? resolve() : reject(new TypeError('account-lock-handshake-invalid')));
  });
   if (exited) throw lockError ?? new TypeError('account-lock-lost');
   return await operation(() => { if (exited) throw lockError ?? new TypeError('account-lock-lost'); });
  } finally { child.stdin.end(); await finished; }
 }
 function validatePending(pending) {
  const { digest: storedDigest, ...body } = pending ?? {};
  if (storedDigest !== digest(JSON.stringify(body)) || body.type !== 'PendingSignedTransactionEffect' || body.address !== address || body.chainId !== chainId || !ni(body.executionId)) throw new TypeError('pending-transaction-custody-corrupt');
  const transaction = Transaction.from(body.serializedTransaction);
  if (!transaction.isSigned() || transaction.from !== address || transaction.chainId !== BigInt(chainId) || transaction.hash !== body.transactionHash) throw new TypeError('pending-signed-transaction-binding-mismatch');
  return transaction;
 }
 const completedPath = executionId => join(directory, 'completed-' + digest(executionId) + '.json');
 async function reconcilePending(pending, guard) {
  validatePending(pending);
  const hash = pending.transactionHash;
  const receipt = await rpc({ method: 'eth_getTransactionReceipt', params: [hash] });
  if (receipt === null) return { status: 'pending', transactionHash: hash, executionId: pending.executionId, newTradeAllowed: false };
  if (receipt?.transactionHash?.toLowerCase() !== hash || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash ?? '') || ![0n, 1n].includes(quantity(receipt.status))) throw new TypeError('correlated-transaction-receipt-required');
  const finalized = await rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
  if (!finalized || quantity(finalized.number) < quantity(receipt.blockNumber)) return { status: 'pending-finality', transactionHash: hash, executionId: pending.executionId, newTradeAllowed: false };
  const canonical = await rpc({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
  if (canonical?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || quantity(canonical.number) !== quantity(receipt.blockNumber)) throw new TypeError('canonical-finalized-transaction-receipt-required');
  const body = { type: 'FinalizedTransactionEffect', executionId: pending.executionId, transactionHash: hash, chainId, address, evidence: pending.evidence, receipt, observedAt: clock(), disposition: quantity(receipt.status) === 1n ? 'succeeded' : 'reverted' };
  // Persist the observed result before calling the idempotent accounting
  // consumer. Its acknowledgement is also durable before pending is cleared.
  const observedPath = join(directory, 'observed-' + hash.slice(2) + '.json');
  const existing = await load(observedPath);
  const observed = existing ?? { ...body, digest: digest(JSON.stringify(body)) };
  if (existing) {
   const {digest: storedDigest,...storedBody}=existing;
   if(storedDigest!==digest(JSON.stringify(storedBody))||existing.transactionHash!==hash||existing.executionId!==pending.executionId||existing.receipt.blockHash!==receipt.blockHash)throw new TypeError('transaction-outcome-custody-conflict');
  }
  if (!existing) await save(observedPath, observed, true);
  guard();
  const outcome = await recordOutcome(observed);
  if (!ni(outcome?.id) || outcome.transactionHash !== hash) throw new TypeError('correlated-recorded-transaction-outcome-required');
  if(outcome.accountReconciled!==true||outcome.feesReconciled!==true)return {status:'pending-accounting',executionId:pending.executionId,transactionHash:hash,outcome:outcome.id,newTradeAllowed:false};
  const completed = { status: 'reconciled', executionId: pending.executionId, transactionHash: hash, disposition: observed.disposition, outcome: outcome.id, custodyAllowsNewAdmission: true };
  guard(); await save(completedPath(pending.executionId), completed, true); await save(pendingPath, null);
  return completed;
 }
 async function execute({ executionId, prepareSigned }) {
  if (!ni(executionId) || typeof prepareSigned !== 'function') throw new TypeError('content-addressed-execution-and-trusted-preparer-required');
  return locked(async guard => {
   const pending = await load(pendingPath);
   if (pending) return reconcilePending(pending, guard);
   const completed = await load(completedPath(executionId));
   if (completed) { if (completed.executionId !== executionId) throw new TypeError('completed-execution-reference-mismatch'); return completed; }
   const prepared = await prepareSigned();
   const transaction = Transaction.from(prepared?.serializedTransaction);
   const expires = Date.parse(prepared?.expiresAt), now = Date.parse(clock());
   if (!transaction.isSigned() || transaction.from !== address || transaction.chainId !== BigInt(chainId)) throw new TypeError('signed-transaction-custody-account-chain-mismatch');
   if (!Number.isFinite(expires) || !Number.isFinite(now) || now >= expires || !prepared.evidence || typeof prepared.evidence !== 'object') throw new TypeError('current-transaction-effect-admission-required');
   const body = { type: 'PendingSignedTransactionEffect', executionId, address, chainId, transactionHash: transaction.hash, serializedTransaction: transaction.serialized, evidence: structuredClone(prepared.evidence), expiresAt: prepared.expiresAt, recordedAt: clock() };
   const admitted = { ...body, digest: digest(JSON.stringify(body)) };
   guard(); await save(pendingPath, admitted);
   // A timeout, malformed acknowledgement, or process death leaves the exact
   // signed bytes in custody. Recovery only reads this hash; it never signs a
   // replacement or assumes an absent receipt means the effect did not occur.
   guard();
   try {
    const acknowledged = await rpc({ method: 'eth_sendRawTransaction', params: [transaction.serialized] });
    if (typeof acknowledged !== 'string' || acknowledged.toLowerCase() !== transaction.hash) throw new TypeError('broadcast-transaction-hash-mismatch');
   } catch { return { status: 'broadcast-uncertain', executionId, transactionHash: transaction.hash, newTradeAllowed: false }; }
   return reconcilePending(admitted, guard);
  });
 }
 async function reconcile() { return locked(async guard => { const pending = await load(pendingPath); return pending ? reconcilePending(pending, guard) : { status: 'no-pending-transaction' }; }); }
 return Object.freeze({ execute, reconcile });
}
