import assert from 'node:assert/strict';
import {test} from 'node:test';
const impl=await import('./runner-job.mjs').catch(()=>({}));
const input=()=>({mode:'explore',origin:'http://app.kody.internal:3000',request:{steps:[{goto:'/'}],viewport:{width:640,height:480},timeoutMs:1000}});
test('explore dispatch accepts only its distinct typed job and derives its deadline',()=>{
 assert.equal(typeof impl.parseRunnerJob,'function','explore dispatch is not implemented');
 const parsed=impl.parseRunnerJob(input());assert.equal(parsed.mode,'explore');assert.equal(parsed.timeoutMs,1000);assert.deepEqual(parsed.request,input().request);
 for(const changed of [{...input(),provider:'external'},{...input(),origin:'http://evil.example'},{...input(),mode:'chat'},{...input(),request:{...input().request,model:'x'}}]) assert.throws(()=>impl.parseRunnerJob(changed));
});
test('legacy replay dispatch remains its old closed browser job',()=>{
 assert.equal(typeof impl.parseRunnerJob,'function');
 const job={steps:[{goto:'/'}],origin:'http://app.kody.internal:3000',viewport:{width:640,height:480},timeoutMs:1000};
 const parsed=impl.parseRunnerJob(job);assert.equal(parsed.mode,'replay');assert.equal(parsed.timeoutMs,1000);assert.equal(parsed.job.evidence,'full');
});
test('exploration hard deadline is request plus10s while replay retains20s',()=>{
 assert.equal(impl.runnerDeadlineMs({mode:'explore',timeoutMs:30000}),40000);
 assert.equal(impl.runnerDeadlineMs({mode:'replay',timeoutMs:30000}),50000);
});
