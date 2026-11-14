// One ephemeral base-side exploration round. Native refs are observations;
// only verified main-document CSS candidates may leave this container.
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {checkJob,JobError,kindOf} from './steps.mjs';
import {AgentBrowserClient} from './agent-browser-client.mjs';
import {installNetworkGuard} from './network-guard.mjs';
const KINDS=new Set(['goto','click','fill','select','press','waitFor']);
const selectorProblem=value=>/^\s*@e[0-9]+\s*$/.test(value)||value.includes('>>')||/^(?:internal:|[A-Za-z_][A-Za-z0-9_-]*\s*=|\/\/|\.\/\/|\(\s*\/\/)/i.test(value.trim());
const stop=status=>{const error=new Error('browser exploration '+status);error.status=status;throw error};
export function checkExploreRequest(raw){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='steps,timeoutMs,viewport')throw new JobError('invalid exploration request');
    if(!Array.isArray(raw.steps)||raw.steps.length<1||raw.steps.length>10||!Object.hasOwn(raw.steps[0]??{},'goto')||!Number.isInteger(raw.timeoutMs)||raw.timeoutMs<1000||raw.timeoutMs>30000)throw new JobError('invalid exploration bounds');
    if(!raw.viewport||typeof raw.viewport!=='object'||Array.isArray(raw.viewport)||Object.keys(raw.viewport).sort().join(',')!=='height,width')throw new JobError('invalid exploration viewport');
    checkJob({...raw,origin:'http://app.kody.internal:3000',evidence:'lean'});
    for(const step of raw.steps){const kind=kindOf(step);if(!KINDS.has(kind))throw new JobError('invalid exploration action');const selector=['click','waitFor'].includes(kind)?step[kind]:['fill','select'].includes(kind)?step[kind][0]:undefined;if(selector!==undefined&&selectorProblem(selector))throw new JobError('exploration requires CSS');}
    return raw;
}
function command(step,origin){
    const kind=kindOf(step),v=step[kind];
    if(kind==='goto')return ['open',new URL(v,origin).href];
    if(kind==='fill'||kind==='select')return [kind,...v];
    if(kind==='waitFor')return ['wait',v];
    return [kind,v];
}
const cssString=value=>value.replace(/[\0-\x1f\x7f"\\]/g,c=>'\\'+c.codePointAt(0).toString(16)+' ');
async function endpoint(){const response=await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(1000)});if(!response.ok)stop('unavailable');return (await response.json()).webSocketDebuggerUrl;}
async function scope(browser){const session=await browser.newBrowserCDPSession();try{const {browserContextIds}=await session.send('Target.getBrowserContexts');const {targetInfos}=await session.send('Target.getTargets');return {contexts:browserContextIds,targets:targetInfos.filter(t=>t.type==='page')};}finally{await session.detach().catch(()=>{});}}
async function boundedCleanup(action){let timer;try{await Promise.race([Promise.resolve().then(action).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,1000);timer.unref?.();})]);}finally{clearTimeout(timer);}}
export async function runExplore(raw,{origin,chromium,clientFactory=options=>new AgentBrowserClient(options),getEndpoint=endpoint,now=()=>performance.now(),workRoot='/tmp',setTimer=setTimeout,clearTimer=clearTimeout}={}){
    const request=checkExploreRequest(raw);
    const app=new URL(origin);
    if(app.protocol!=='http:'||app.hostname!=='app.kody.internal'||app.username||app.password||app.pathname!=='/'||app.search||app.hash)throw new JobError('invalid exploration origin');
    const started=now(),result={status:'failed',snapshot:'',candidates:[],actionsCompleted:0,durationMs:0,cliCalls:0,truncated:false};
    const controller=new AbortController();let browser,context,page,client,work,networkGuard,ended=false,denied=false;
    const remaining=()=>Math.max(1,request.timeoutMs-(now()-started));
    const deny=()=>{denied=true;controller.abort();};
    const active=()=>{if(denied)stop('blocked');if(ended||controller.signal.aborted||now()-started>=request.timeoutMs)stop('timeout');};
    let expire;const expired=new Promise((_,reject)=>{expire=()=>{ended=true;controller.abort();const error=new Error('exploration deadline');error.status='timeout';reject(error);};});
    const timer=setTimer(expire,request.timeoutMs);timer.unref?.();
    let expected;
    const closedWorld=async()=>{active();const current=await scope(browser);if(current.contexts.length!==1||current.targets.length!==1||current.targets[0].browserContextId!==current.contexts[0]){deny();stop('blocked');}if(expected&&(current.targets[0].targetId!==expected.target||current.contexts[0]!==expected.context)){deny();stop('blocked');}return current;};
    const cli=async tokens=>{active();if(result.cliCalls>=199)stop('failed');await closedWorld();result.cliCalls++;const response=await client.command(tokens,{timeoutMs:Math.min(5000,remaining())});active();await closedWorld();return response;};
    const execute=async()=>{
        work=await mkdtemp(join(workRoot,'browser-explore-'));active();
        await mkdir(join(work,'home'),{mode:0o700});await mkdir(join(work,'sockets'),{mode:0o700});active();
        browser=await chromium.launch({headless:true,chromiumSandbox:false,timeout:remaining(),args:['--remote-debugging-port=9222','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--no-first-run',
            '--disable-features=WebMCPTesting,DevToolsWebMCPSupport',`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${app.hostname}`]});
        if(ended){await boundedCleanup(()=>browser.close());browser=undefined;active();}active();
        context=await browser.newContext({viewport:request.viewport,serviceWorkers:'block',acceptDownloads:false});
        if(ended){await boundedCleanup(()=>context.close());context=undefined;active();}active();
        networkGuard=await installNetworkGuard(context,{origin:app.origin,remaining,onDenied:deny});active();
        page=await context.newPage();active();networkGuard.bindPage(page);
        const initial=await closedWorld();expected={target:initial.targets[0].targetId,context:initial.contexts[0]};
        // Ask Chromium's standard CSS parser directly. Playwright's CSS
        // engine also accepts its own pseudo-selectors, which native CLI
        // querySelector does not; never promote those into an action prefix.
        const selectors=request.steps.flatMap(step=>{const kind=kindOf(step);return ['click','waitFor'].includes(kind)?[step[kind]]:['fill','select'].includes(kind)?[step[kind][0]]:[];});
        if(selectors.length){const parser=await context.newCDPSession(page);try{const {root}=await parser.send('DOM.getDocument',{depth:0});for(const selector of selectors){try{await parser.send('DOM.querySelector',{nodeId:root.nodeId,selector});}catch{stop('blocked');}active();}}finally{await parser.detach().catch(()=>{});}}
        client=clientFactory({endpoint:await getEndpoint(),home:join(work,'home'),socketDir:join(work,'sockets'),signal:controller.signal});active();
        for(const step of request.steps){await cli(command(step,app.origin));result.actionsCompleted++;}
        const observed=await cli(['snapshot','-i','-c','-d','6']);
        if(typeof observed.snapshot!=='string'||!observed.refs||typeof observed.refs!=='object'||Array.isArray(observed.refs))stop('failed');
        result.snapshot=observed.snapshot.slice(0,8000);result.truncated=observed.snapshot.length>8000;
        // Native snapshot JSON omits frame provenance. Do not guess which
        // frame supplied an id that also exists in the main document.
        if(page.frames().length===1){
            const refs=Object.entries(observed.refs);if(refs.length>32)result.truncated=true;
            optional: for(const [ref,metadata] of refs.slice(0,32)){
                if(remaining()<2000||result.cliCalls>=190){result.truncated=true;break;}
                if(!/^e[0-9]{1,6}$/.test(ref)||!metadata||typeof metadata!=='object')continue;
                for(const attribute of ['data-testid','id']){
                    if(remaining()<2000||result.cliCalls>=190){result.truncated=true;break optional;}
                    const {value}=await cli(['get','attr','@'+ref,attribute]);
                    if(typeof value!=='string'||value.length<1||value.length>256||value.includes('\0'))continue;
                    const selector='['+attribute+'="'+cssString(value)+'"]';if(selector.length>1024)continue;
                    if(remaining()<2000||result.cliCalls>=190){result.truncated=true;break optional;}
                    const counted=await cli(['get','count',selector]);
                    if(counted.count===1){result.candidates.push({ref,selector,...(typeof metadata.role==='string'?{role:metadata.role.slice(0,64)}:{}),...(typeof metadata.name==='string'?{name:metadata.name.slice(0,256)}:{})});break;}
                }
            }
        }
        active();result.status='observed';
    };
    try{await Promise.race([execute(),expired]);}
    catch(error){result.status=denied?'blocked':['timeout','unavailable','blocked'].includes(error?.status)?error.status:'failed';result.snapshot='';result.candidates=[];}
    finally{
        ended=true;controller.abort();clearTimer(timer);
        if(client){result.cliCalls++;await boundedCleanup(()=>client.command(['close'],{cleanup:true,timeoutMs:1000}));}
        if(context)await boundedCleanup(()=>context.close());
        if(browser)await boundedCleanup(()=>browser.close());
        if(work)await rm(work,{recursive:true,force:true}).catch(()=>{});
        try{await networkGuard?.finish();}catch{denied=true;}
        if(denied){result.status='blocked';result.snapshot='';result.candidates=[];}
        result.durationMs=Math.min(120000,Math.max(0,Math.round(now()-started)));
    }
    return result;
}
