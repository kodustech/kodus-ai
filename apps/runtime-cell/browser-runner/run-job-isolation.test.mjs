// Replay used route.continue: a response redirect escaped the only URL check,
// and WebSocket/popup traffic had no matching first-denial boundary.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {runJob} from './run-job.mjs';
import {JobError} from './steps.mjs';
const origin='http://app.kody.internal:3000';
const job={evidence:'lean',steps:[{goto:'/'},{screenshot:'after-navigation'}],origin,viewport:{width:640,height:480},timeoutMs:30000};
function fixture({redirect=false,popup=false,websocket=false,foreign=false,denyDuringClose=false,delayedFetchRejection=false}={}){
 const calls=[];let route,wsHandler,time=0,rejectFetch;
 const context=new EventEmitter(),page=new EventEmitter(),other={close:async()=>calls.push('popup.close')};
 const request={url:()=>foreign?'http://app.kody.internal:9999/leak':origin+'/',frame:()=>({page:()=>popup?other:page}),postDataBuffer:()=>null};
 const response={status:()=>redirect?302:200,headers:()=>({}),body:async()=>Buffer.from('owned'),dispose:async()=>calls.push('dispose')};
 const routed={request:()=>request,continue:async()=>calls.push('unsafe.continue'),abort:async()=>calls.push('abort'),fetch:async opts=>{calls.push(['fetch',opts]);if(delayedFetchRejection)return new Promise((_,reject)=>{rejectFetch=reject});return response},fulfill:async()=>calls.push('fulfill')};
 page.goto=async()=>{calls.push('goto');if(websocket){if(wsHandler)wsHandler({close:()=>calls.push('websocket.close')});else calls.push('unsafe.websocket');}else if(delayedFetchRejection){void route(routed);}else await route(routed);};
 page.screenshot=async()=>{calls.push('screenshot');return Buffer.from('png')};
 context.route=async(_pattern,handler)=>{route=handler;calls.push('route')};context.routeWebSocket=async(_pattern,handler)=>{wsHandler=handler;calls.push('websocket.guard')};context.newPage=async()=>{calls.push('page');return page};context.close=async()=>{calls.push('context.close');if(delayedFetchRejection)setImmediate(()=>rejectFetch(new Error('fixture')));if(denyDuringClose)await wsHandler({close:()=>calls.push('websocket.close')});};
 const browser={newContext:async opts=>{calls.push(['context',opts]);return context},close:async()=>calls.push('browser.close')};
 return {calls,run:()=>runJob(job,{chromium:{launch:async()=>browser},now:()=>time,sleep:async ms=>{time+=ms}})};
}
for(const [name,options] of [['redirect',{redirect:true}],['same-origin popup request',{popup:true}],['WebSocket',{websocket:true}],['foreign origin/port',{foreign:true}]])test(`replay refuses ${name} as observer policy, without an app failure result`,async()=>{
 const f=fixture(options);await assert.rejects(f.run(),error=>error instanceof JobError);
 assert.ok(!f.calls.includes('unsafe.continue'));assert.ok(!f.calls.includes('unsafe.websocket'));assert.ok(!f.calls.includes('screenshot'));
 assert.equal(f.calls.filter(c=>c==='browser.close').length,1);assert.equal(f.calls.filter(c=>c==='context.close').length,1);
 if(options.redirect){assert.ok(f.calls.some(c=>Array.isArray(c)&&c[0]==='fetch'&&c[1].maxRedirects===0));assert.ok(f.calls.includes('dispose'));}
});

test('a guard denial arriving during context cleanup still discards the replay result',async()=>{
 const f=fixture({denyDuringClose:true});await assert.rejects(f.run(),error=>error instanceof JobError);
});

test('an in-flight fetch rejecting during outer cleanup cannot return selected proof',async()=>{
 const f=fixture({delayedFetchRejection:true});await assert.rejects(f.run(),error=>error instanceof JobError);
 assert.ok(f.calls.includes('abort'));
});
