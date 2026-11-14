import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
const impl = await import('./explore-job.mjs').catch(()=>({}));
const req = () => ({steps:[{goto:'/'},{fill:['#name','--config evil']}],viewport:{width:640,height:480},timeoutMs:3000});
const origin='http://app.kody.internal:3000';
function fake({failure,deny,redirect=false,frames=1,targets=1,huge=false}={}){
 const calls=[];const page={frames:()=>Array.from({length:frames},()=>({})),locator:()=>({count:async()=>0}),close:async()=>calls.push(['page.close'])};
 const context=new EventEmitter();let route;
 context.route=async(_pattern,handler)=>{route=handler;calls.push(['route'])};context.routeWebSocket=async()=>calls.push(['websocket.guard']);
 context.newCDPSession=async()=>({send:async(method,params)=>{calls.push(['css',method,params]);if(method==='DOM.getDocument')return {root:{nodeId:1}};if(params.selector==='['||params.selector.includes(':text('))throw new Error('invalid standard CSS');return {nodeId:0};},detach:async()=>calls.push(['css.detach'])});
 context.newPage=async()=>{calls.push(['page']);return page};context.close=async()=>calls.push(['context.close']);
 const browser={newContext:async options=>{calls.push(['context',options]);return context},close:async()=>calls.push(['browser.close']),newBrowserCDPSession:async()=>({send:async method=>method==='Target.getBrowserContexts'?{browserContextIds:['ctx']}:{targetInfos:Array.from({length:targets},(_,n)=>({type:'page',targetId:'page'+n,browserContextId:'ctx'}))},detach:async()=>{}})};
 let requestCount=0;
 const client={command:async tokens=>{
  calls.push(['cli',tokens]);requestCount++;
  if(tokens[0]==='close')return {};
  if(failure&&requestCount===failure){const e=new Error('PRIVATE stderr');e.status='timeout';throw e}
  if(tokens[0]==='open'&&(deny||redirect)){
   const response={status:()=>redirect?302:200,headers:()=>({}),dispose:async()=>calls.push(['response.dispose'])};
   await route({request:()=>({url:()=>deny?'http://app.kody.internal:9999/leak':origin+'/',frame:()=>({page:()=>page})}),abort:async()=>calls.push(['abort']),fetch:async()=>{calls.push(['fetch']);return response},fulfill:async()=>calls.push(['fulfill'])});
  }
  if(tokens[0]==='snapshot')return {snapshot:huge?'x'.repeat(9000):'- textbox Name [ref=e1]',refs:{e1:{role:'textbox',name:'Name'}}};
  if(tokens[0]==='get'&&tokens[1]==='attr')return {value:tokens[3]==='data-testid'?'name-field':null};
  if(tokens[0]==='get'&&tokens[1]==='count')return {count:1};
  return {};
 }};
 return {calls,page,context,browser,client,chromium:{launch:async options=>{calls.push(['launch',options]);return browser}},getEndpoint:async()=> 'ws://127.0.0.1:9222/devtools/browser/owned'};
}
async function run(f, request=req(), more={}){assert.equal(typeof impl.runExplore,'function','typed explorer is not implemented');return impl.runExplore(request,{origin,chromium:f.chromium,clientFactory:()=>f.client,getEndpoint:f.getEndpoint,...more})}

test('request remains the closed prefix, first goto, bounded and CSS only',()=>{
 assert.equal(typeof impl.checkExploreRequest,'function','request validator is not implemented');
 assert.deepEqual(impl.checkExploreRequest(req()),req());
 for(const changed of [{...req(),extra:true},{...req(),steps:[{click:'#x'}]},{...req(),steps:[{goto:'/'},{screenshot:'x'}]},{...req(),steps:[{goto:'/'},{click:'@e1'}]},{...req(),steps:[{goto:'/'},{click:'internal:role=button'}]},{...req(),steps:[{goto:'/'},{click:'xpath=//x'}]},{...req(),steps:Array.from({length:11},()=>({goto:'/'}))},{...req(),timeoutMs:30001}]) assert.throws(()=>impl.checkExploreRequest(changed));
});
test('prefix then snapshot/ref attrs becomes a bounded unique main-frame CSS candidate',async()=>{
 const f=fake();const result=await run(f);
 assert.equal(result.status,'observed');assert.equal(result.actionsCompleted,2);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].selector,'[data-testid="name-field"]');
 assert.ok(f.calls.findIndex(x=>x[0]==='route')<f.calls.findIndex(x=>x[0]==='page'));
 assert.equal(f.calls.find(x=>x[0]==='context')[1].serviceWorkers,'block');
 assert.deepEqual(f.calls.filter(x=>x[0]==='cli').slice(0,2).map(x=>x[1]),[['open',origin+'/'],['fill','#name','--config evil']]);
 assert.ok(f.calls.some(x=>x[0]==='browser.close'));assert.ok(f.calls.some(x=>x[0]==='context.close'));
});
test('first denial ends the job without navigation recovery, remaining actions or snapshots',async()=>{
 const f=fake({deny:true});const result=await run(f);
 assert.equal(result.status,'blocked');assert.equal(result.actionsCompleted,0);assert.deepEqual(result.candidates,[]);
 assert.equal(f.calls.filter(x=>x[0]==='cli'&&x[1][0]!=='close').length,1);assert.ok(!f.calls.some(x=>x[0]==='fetch'));
});
test('redirect is unsupported, aborts the job and disposes the fetched response',async()=>{
 const f=fake({redirect:true});const result=await run(f);
 assert.equal(result.status,'blocked');assert.ok(f.calls.some(x=>x[0]==='abort'));assert.ok(f.calls.some(x=>x[0]==='response.dispose'));assert.ok(!f.calls.some(x=>x[0]==='fulfill'));
});
test('CLI timeout is typed and terminal; raw errors never become an observation',async()=>{
 const f=fake({failure:2});const result=await run(f);
 assert.equal(result.status,'timeout');assert.equal(result.actionsCompleted,1);assert.equal(result.snapshot,'');assert.ok(!JSON.stringify(result).includes('PRIVATE'));
 assert.equal(f.calls.filter(x=>x[0]==='cli'&&x[1][0]!=='close').length,2);
});
test('a foreign context/page is refused before any CLI attach/action',async()=>{
 const f=fake({targets:2});const result=await run(f);
 assert.equal(result.status,'blocked');assert.equal(f.calls.filter(x=>x[0]==='cli').length,0);
});
test('iframe content never promotes a main-document CSS candidate',async()=>{
 const f=fake({frames:2});const result=await run(f);
 assert.equal(result.status,'observed');assert.deepEqual(result.candidates,[]);assert.ok(!f.calls.some(x=>x[0]==='cli'&&x[1][0]==='get'));
});
test('snapshot output is bounded and reports truncation',async()=>{
 const result=await run(fake({huge:true}));assert.equal(result.status,'observed');assert.equal(result.snapshot.length,8000);assert.equal(result.truncated,true);
});
test('a Chromium launch resolving after deadline is closed without creating a context',async()=>{
 const f=fake();let launch,expire,started;const ready=new Promise(resolve=>started=resolve);f.chromium.launch=()=>new Promise(resolve=>{launch=resolve;started();});
 const pending=run(f,req(),{setTimer:fn=>{expire=fn;return 1},clearTimer:()=>{}});
 await ready;expire();const result=await pending;
 assert.equal(result.status,'timeout');launch(f.browser);await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.calls.some(x=>x[0]==='browser.close'));assert.ok(!f.calls.some(x=>x[0]==='context'));
});
test('the browser CSS parser rejects malformed selectors before CLI actions',async()=>{
 const f=fake();
 const request=req();request.steps.push({click:'['});const result=await run(f,request);
 assert.equal(result.status,'blocked');assert.equal(f.calls.filter(x=>x[0]==='cli').length,0);
});
test('unknown viewport controls are refused rather than passed to Chromium',()=>{
 assert.throws(()=>impl.checkExploreRequest({...req(),viewport:{...req().viewport,permissions:['clipboard-read']}}));
});
test('optional candidates stop before deadline without discarding a useful snapshot',async()=>{
 const f=fake();let clock=0;const original=f.client.command;
 f.client.command=async tokens=>{const out=await original(tokens);if(tokens[0]==='snapshot')clock=1500;return out;};
 const result=await run(f,req(),{now:()=>clock});
 assert.equal(result.status,'observed');assert.ok(result.snapshot);assert.equal(result.truncated,true);assert.deepEqual(result.candidates,[]);
 assert.ok(!f.calls.some(x=>x[0]==='cli'&&x[1][0]==='get'));
});

test('standard Chromium CSS validation refuses Playwright-only selector extensions before CLI',async()=>{
 const f=fake();const request=req();request.steps.push({click:'button:text("Save")'});const result=await run(f,request);
 assert.equal(result.status,'blocked');assert.equal(f.calls.filter(x=>x[0]==='cli').length,0);
 assert.ok(f.calls.some(x=>x[0]==='css'&&x[1]==='DOM.querySelector'));assert.ok(f.calls.some(x=>x[0]==='css.detach'));
});

test('a late popup denial during cleanup cannot return an observed snapshot',async()=>{
 const f=fake(),close=f.context.close;f.context.close=async()=>{f.context.emit('page',{close:async()=>{}});await close();};
 const result=await run(f);assert.equal(result.status,'blocked');assert.equal(result.snapshot,'');assert.deepEqual(result.candidates,[]);
});
