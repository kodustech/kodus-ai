import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
const impl=await import('./agent-browser-client.mjs').catch(()=>({}));
test('untrusted flag-looking text stays in bounded JSON stdin, never process argv/environment',async()=>{
 assert.equal(typeof impl.AgentBrowserClient,'function','native CLI client not implemented');
 const records=[];
 const exec=(file,args,opts,callback)=>{const child=new EventEmitter();child.stdin={end:input=>{records.push({file,args,opts,input});queueMicrotask(()=>callback(null,JSON.stringify([{success:true,result:{ok:true}}]),''))}};child.kill=()=>{};return child};
 const client=new impl.AgentBrowserClient({endpoint:'ws://127.0.0.1:9222/devtools/browser/known',home:'/tmp/owned/home',socketDir:'/tmp/owned/sockets',exec});
 for(const value of ['--config','--config evil','--provider=x','-p','--cdp=ws://127.0.0.1:9']) await client.command(['fill','#name',value]);
 for(const record of records){assert.equal(record.file,'/usr/local/bin/agent-browser');assert.equal(record.args.filter(x=>x==='--config').length,1);assert.equal(record.args.at(-1),'--omit-command');assert.deepEqual(JSON.parse(record.input)[0].slice(0,2),['fill','#name']);assert.ok(!record.args.some(x=>x==='evil'||x==='--provider=x'));assert.equal(record.opts.cwd,'/runner');assert.equal(record.opts.env.AGENT_BROWSER_NO_VERSION_CHECK,'1');assert.equal(record.opts.env.AGENT_BROWSER_NO_WEBMCP,'1');assert.equal(record.opts.env.AGENT_BROWSER_PLUGINS,'[]');assert.equal(record.opts.env.AGENT_BROWSER_PROVIDER,undefined)}
});
test('native errors are typed without exposing stderr or command output',async()=>{
 assert.equal(typeof impl.AgentBrowserClient,'function');
 const exec=(_file,_args,_opts,callback)=>{const child=new EventEmitter();child.stdin={end:()=>queueMicrotask(()=>callback(Object.assign(new Error('SECRET'),{killed:true}),'{"SECRET":"x"}','SECRET'))};return child};
 const client=new impl.AgentBrowserClient({endpoint:'ws://127.0.0.1:9222/devtools/browser/known',home:'/tmp/owned/home',socketDir:'/tmp/owned/sockets',exec});
 await assert.rejects(client.command(['snapshot']),e=>e.status==='timeout'&&!e.message.includes('SECRET'));
});
test('CDP endpoint cannot point at a host or provider URL',()=>{
 assert.equal(typeof impl.AgentBrowserClient,'function');
 for(const endpoint of ['ws://host.orb.internal:9222/x','wss://provider.example/x','ws://127.0.0.1:9223/x']) assert.throws(()=>new impl.AgentBrowserClient({endpoint,home:'/tmp/owned/home',socketDir:'/tmp/owned/sockets'}));
});
