import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBaseNativeUsdcExecutor} from '../src/base-spot-adapter.mjs';
test('Base consumes the shared decision hash but still refuses absent current principal standing before signing',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'base-decision-reference-'));let resolved=0,signed=0;
 try{
  const quoteReference='ni:///sha-256;'+ 'a'.repeat(43),preparationReference='ni:///sha-256;'+ 'b'.repeat(43),decisionReference='c'.repeat(64);
  const executor=createBaseNativeUsdcExecutor({directory,rpc:async()=>{throw Error('unexpected network call');},recordOutcome:async()=>{throw Error('unexpected outcome');},signTransaction:async()=>{signed++;throw Error('unexpected signing');},resolveExecutionRecords:async refs=>{resolved++;assert.equal(refs.decisionReference,decisionReference);return {quote:{id:quoteReference},preparation:{id:preparationReference},decision:{id:decisionReference},principalAuthorization:{id:'ni:///sha-256;'+ 'd'.repeat(43)}};}});
  await assert.rejects(executor.execute({quoteReference,preparationReference,decisionReference}),/current-base-principal-office-authorization-required/);
  assert.equal(resolved,1);assert.equal(signed,0);
  await assert.rejects(executor.execute({quoteReference,preparationReference,decisionReference:'not-a-decision-hash'}),/market-decision-reference-required/);
  assert.equal(resolved,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
