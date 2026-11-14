import assert from 'node:assert/strict';import {test} from 'node:test';import {EventEmitter} from 'node:events';
const impl=await import('./network-guard.mjs').catch(()=>({}));
const origin='http://app.kody.internal:3000';
async function fixture(overrides={},options={}){
 assert.equal(typeof impl.installNetworkGuard,'function','shared guard is not implemented');
 const calls=[],context=new EventEmitter(),page={};let route,ws,denials=0;
 context.routeWebSocket=async(_,fn)=>{ws=fn;calls.push('ws.guard')};context.route=async(_,fn)=>{route=fn;calls.push('http.guard')};
 const guard=await impl.installNetworkGuard(context,{origin,remaining:()=>5000,onDenied:()=>{denials++},...options});guard.bindPage(page);
 const response={status:()=>200,headers:()=>({}),body:async()=>Buffer.from('ok'),dispose:async()=>calls.push('dispose'),...overrides};
 const handle=async({url=origin+'/',owner=page,post=null}={})=>route({request:()=>({url:()=>url,frame:()=>({page:()=>owner}),postDataBuffer:()=>post}),abort:async()=>calls.push('abort'),fetch:async opts=>{calls.push(['fetch',opts]);return response},fulfill:async()=>calls.push('fulfill')});
 return {guard,calls,handle,ws,context,page,denials:()=>denials};
}
test('allowed HTTP uses one zero-redirect fetch and disposes response',async()=>{
 const f=await fixture();await f.handle();f.guard.check();assert.deepEqual(f.calls,['ws.guard','http.guard',['fetch',{maxRedirects:0,timeout:3000}],'fulfill','dispose']);
});
for(const [name,response]of[['redirect',{status:()=>302}],['large headers',{headers:()=>({'x-large':'x'.repeat(32769)})}],['large body',{body:async()=>Buffer.alloc(8*1024*1024+1)}]])test(`refuses ${name}, disposes response and retains a terminal denial`,async()=>{
 const f=await fixture(response);await f.handle();assert.throws(()=>f.guard.check(),/browser network policy refused/);assert.equal(f.denials(),1);assert.ok(f.calls.includes('abort'));assert.ok(f.calls.includes('dispose'));assert.ok(!f.calls.includes('fulfill'));await f.handle();assert.equal(f.denials(),1);assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='fetch').length,1);
});
test('foreign port/page and oversized post are denied before any upstream',async()=>{
 for(const request of[{url:'http://app.kody.internal:9999/'},{owner:{}},{post:Buffer.alloc(1024*1024+1)}]){const f=await fixture();await f.handle(request);assert.throws(()=>f.guard.check());assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==='fetch'));}
});
test('WebSocket and popup are terminal and cannot disclose URL in an error',async()=>{
 const f=await fixture();f.ws({close:()=>f.calls.push('ws.close')});assert.throws(()=>f.guard.check(),/^Error: browser network policy refused$/);assert.equal(f.denials(),1);
 const popup={close:async()=>f.calls.push('popup.close')};f.context.emit('page',popup);await Promise.resolve();assert.ok(f.calls.includes('popup.close'));assert.equal(f.denials(),1);
});

test('finish fences future callbacks and waits for an in-flight refusal before allowing proof',async()=>{
 let rejectBody;const f=await fixture({body:()=>new Promise((_,reject)=>{rejectBody=reject})});
 const pending=f.handle();while(!rejectBody)await Promise.resolve();
 assert.equal(typeof f.guard.finish,'function');const finished=f.guard.finish();rejectBody(new Error('fixture body failure'));
 await assert.rejects(finished,/browser network policy refused/);await pending;
 const before=f.calls.filter(c=>Array.isArray(c)&&c[0]==='fetch').length;await f.handle();assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='fetch').length,before);
});

test('finish has a bounded deadline for an unresolved route and never allows proof',async()=>{
 let expire,resolveBody,cleared=false;const f=await fixture({body:()=>new Promise(resolve=>{resolveBody=resolve})},{setTimer:fn=>{expire=fn;return 1},clearTimer:()=>{cleared=true}});
 const route=f.handle();while(!resolveBody)await Promise.resolve();const finished=f.guard.finish();expire();await assert.rejects(finished,/browser network policy refused/);assert.equal(cleared,true);
 resolveBody(Buffer.from('late'));await route;assert.ok(!f.calls.includes('fulfill'));
});
