import assert from "node:assert/strict";
import test from "node:test";
import { createAlpacaAdapter } from "../src/alpaca-adapter.mjs";
const now="2026-09-05T00:00:00Z";
const grant={type:"RevocableBrokerageAuthorityGrant",id:"urn:grant:fixture",adapter:"alpaca-trading-paper",validUntil:"2026-09-06T00:00:00Z",scopes:["account:read"]};
function adapter(body,calls=[]) {return createAlpacaAdapter({product:"alpaca-trading-paper",baseUrl:"https://paper-api.alpaca.markets",authorityClient:{async authorizedRequest(request){calls.push(request);return {status:200,headers:{"x-request-id":"fixture"},body,authorityCustodyReceipt:"urn:custody:fixture"};}}});}
test("venue receipt identity is stable across response ordering and retains response distinctions",async()=>{
 const calls=[]; const a=await adapter({name:"Équipe 😀",balance:10},calls).readAccount({grant,now});
 const b=await adapter({balance:10,name:"Équipe 😀"}).readAccount({grant,now});
 assert.equal(a.id,b.id); assert.equal(calls.length,1); assert.equal(calls[0].method,"GET"); assert.equal(calls[0].authorityGrantReference,grant.id);
 assert.notEqual((await adapter({balance:11,name:"Équipe 😀"}).readAccount({grant,now})).id,a.id);
});
test("credential response fields are excluded before identifying the receipt",async()=>{
 const clean=await adapter({balance:10}).readAccount({grant,now});
 const redacted=await adapter({balance:10,api_secret:"fixture"}).readAccount({grant,now});
 assert.equal(clean.id,redacted.id); assert.deepEqual(redacted.payload,{balance:10}); assert.equal(redacted.credentialsExported,false);
});
test("expired authority refuses before the offline transport is called",async()=>{
 const calls=[]; await assert.rejects(adapter({},calls).readAccount({grant:{...grant,validUntil:now},now}),/authority-expired/); assert.equal(calls.length,0);
});
