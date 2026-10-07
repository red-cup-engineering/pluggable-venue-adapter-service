import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet, Transaction } from 'ethers';
import { createTransactionEffectCustody } from '../src/transaction-effect-custody.mjs';

const at='2026-10-06T12:00:00Z',executionId='ni:///sha-256;'+'a'.repeat(43),otherId='ni:///sha-256;'+'b'.repeat(43);
const wallet=Wallet.createRandom(); // Isolated test key, never a fleet account.
const serializedTransaction=await wallet.signTransaction({chainId:8453,type:2,nonce:7,to:wallet.address,value:1n,gasLimit:21000n,maxFeePerGas:2000000n,maxPriorityFeePerGas:1000000n});
const transactionHash=Transaction.from(serializedTransaction).hash,blockHash='0x'+'ab'.repeat(32);
const prepared={serializedTransaction,expiresAt:'2026-10-06T12:00:30Z',evidence:{decision:executionId}};
const receipt={transactionHash,blockHash,blockNumber:'0xa',status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0xf4240',logs:[]};
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'transaction-custody-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
const bindings=(directory,rpc,recordOutcome=async()=>({id:otherId,transactionHash,accountReconciled:true,feesReconciled:true}))=>({directory,address:wallet.address,chainId:8453,rpc,recordOutcome,clock:()=>at});

test('lost broadcast acknowledgement survives reload and refuses a second signed effect',async t=>{
 const directory=await fixture(t);let broadcasts=0,found=false,preparations=0;
 const rpc=async({method,params})=>{
  if(method==='eth_sendRawTransaction'){broadcasts++;const pending=JSON.parse(await readFile(join(directory,'pending.json'),'utf8'));assert.equal(pending.serializedTransaction,params[0]);assert.equal(pending.transactionHash,transactionHash);throw new Error('acknowledgement lost');}
  if(method==='eth_getTransactionReceipt')return found?receipt:null;
  return {number:'0xa',hash:blockHash};
 };
 let custody=createTransactionEffectCustody(bindings(directory,rpc));
 const first=await custody.execute({executionId,prepareSigned:async()=>{preparations++;return prepared;}});assert.equal(first.status,'broadcast-uncertain');
 custody=createTransactionEffectCustody(bindings(directory,rpc));
 assert.equal((await custody.execute({executionId:otherId,prepareSigned:async()=>{preparations++;return prepared;}})).status,'pending');
 assert.equal(preparations,1);assert.equal(broadcasts,1);
 found=true;const recovered=await custody.reconcile();assert.equal(recovered.status,'reconciled');assert.equal(recovered.transactionHash,transactionHash);
 assert.equal(JSON.parse(await readFile(join(directory,'pending.json'),'utf8')),null);
 assert.deepEqual(await custody.execute({executionId,prepareSigned:()=>{throw new Error('must not sign again');}}),recovered);
});

test('mining without finality, a fork, or failed accounting keeps the original effect pending',async t=>{
 const directory=await fixture(t);let finalized=false,canonical=true,accounting=false;
 const rpc=async({method,params})=>{
  if(method==='eth_sendRawTransaction')return transactionHash;
  if(method==='eth_getTransactionReceipt')return receipt;
  return params[0]==='finalized'?{number:finalized?'0xa':'0x9',hash:blockHash}:{number:'0xa',hash:canonical?blockHash:'0x'+'cd'.repeat(32)};
 };
 const custody=createTransactionEffectCustody(bindings(directory,rpc,async()=>{if(!accounting)throw new Error('book write failed');return {id:otherId,transactionHash,accountReconciled:true,feesReconciled:true};}));
 assert.equal((await custody.execute({executionId,prepareSigned:async()=>prepared})).status,'pending-finality');
 finalized=true;canonical=false;await assert.rejects(custody.reconcile(),/canonical-finalized/);
 canonical=true;await assert.rejects(custody.reconcile(),/book write failed/);
 assert.equal(JSON.parse(await readFile(join(directory,'pending.json'),'utf8')).transactionHash,transactionHash);
 accounting=true;assert.equal((await custody.reconcile()).status,'reconciled');
});

test('the OS account lock excludes another executor while authority and signing are in progress',async t=>{
 const directory=await fixture(t);let release,started;
 const ready=new Promise(resolve=>{started=resolve;});const wait=new Promise(resolve=>{release=resolve;});
 const rpc=async({method})=>method==='eth_sendRawTransaction'?transactionHash:null;
 const custody=createTransactionEffectCustody(bindings(directory,rpc));
 const first=custody.execute({executionId,prepareSigned:async()=>{started();await wait;return prepared;}});
 await ready;try { await assert.rejects(createTransactionEffectCustody(bindings(directory,rpc)).reconcile(),/already-running/); } finally {release();}
 await first;
});

test('a recorded receipt without reconciled accounts and fees cannot release pending custody',async t=>{
 const directory=await fixture(t);
 const rpc=async({method})=>method==='eth_sendRawTransaction'?transactionHash:method==='eth_getTransactionReceipt'?receipt:{number:'0xa',hash:blockHash};
 const custody=createTransactionEffectCustody(bindings(directory,rpc,async()=>({id:otherId,transactionHash,accountReconciled:false,feesReconciled:false})));
 const result=await custody.execute({executionId,prepareSigned:async()=>prepared});assert.equal(result.status,'pending-accounting');assert.equal(result.newTradeAllowed,false);
 assert.equal(JSON.parse(await readFile(join(directory,'pending.json'),'utf8')).transactionHash,transactionHash);
});

test('process death after durable staging releases the OS lock but preserves exact signed bytes',async t=>{
 const directory=await fixture(t),moduleUrl=new URL('../src/transaction-effect-custody.mjs',import.meta.url).href;
 const script=`import {createTransactionEffectCustody} from ${JSON.stringify(moduleUrl)};
 const custody=createTransactionEffectCustody({directory:${JSON.stringify(directory)},address:${JSON.stringify(wallet.address)},chainId:8453,clock:()=>${JSON.stringify(at)},rpc:async()=>process.exit(17),recordOutcome:async()=>null});
 await custody.execute({executionId:${JSON.stringify(executionId)},prepareSigned:async()=>(${JSON.stringify(prepared)})});`;
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script]),error=>error.code===17);
 const pending=JSON.parse(await readFile(join(directory,'pending.json'),'utf8'));assert.equal(pending.serializedTransaction,serializedTransaction);
 const custody=createTransactionEffectCustody(bindings(directory,async()=>null));
 const deadline=Date.now()+3000;let result;
 while(!result){try{result=await custody.reconcile();}catch(error){if(!/already-running/.test(error.message)||Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,10));}}
 assert.equal(result.status,'pending');assert.equal(result.transactionHash,transactionHash);
});
