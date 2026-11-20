// Shared observer network policy. A denial is not an application measurement.
// Install before creating/navigating the owned page; bind it before any action.
import {JobError} from './steps.mjs';
export class NetworkPolicyError extends JobError {
    constructor(){super('browser network policy refused');}
}
/** How long one request of the page may take upstream: past it the guard denies the round. */
export const UPSTREAM_TIMEOUT_MS=3000;
const SOCKET_SCHEME={'http:':'ws:','https:':'wss:'};
export function sameOriginSocket(raw,app){
    let url;try{url=new URL(raw);}catch{return false;}
    return url.protocol===SOCKET_SCHEME[app.protocol]&&url.host===app.host&&!url.username&&!url.password;
}
export async function installNetworkGuard(context,{origin,remaining,onDenied=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
    const app=new URL(origin);
    if(app.protocol!=='http:'||app.origin!==origin)throw new NetworkPolicyError();
    let owned,denied=false,fenced=false;const pending=new Set();
    const deny=()=>{if(!denied){denied=true;onDenied();}};
    const check=()=>{if(denied)throw new NetworkPolicyError();};
    const abort=async route=>{try{await route.abort('blockedbyclient');}catch{}};
    // A WebSocket to the app's own origin (ws for http, wss for https, same
    // host and port) reaches the app, as a dev server's reload channel does;
    // its frames are passed through, never measured or compared. Any other
    // socket, or one before the page is bound or after the fence, is terminal.
    await context.routeWebSocket('**/*',async socket=>{
        if(!denied&&!fenced&&owned&&sameOriginSocket(socket.url?.(),app)){try{socket.connectToServer();return;}catch{}}
        deny();try{await socket.close();}catch{}
    });
    const handle=async route=>{
        let response;
        try{
            const req=route.request(),url=new URL(req.url());
            if(denied||fenced||!owned||req.frame().page()!==owned||url.protocol!=='http:'||url.origin!==app.origin){deny();await abort(route);return;}
            if((req.postDataBuffer?.()?.length??0)>1024*1024){deny();await abort(route);return;}
            response=await route.fetch({maxRedirects:0,timeout:Math.max(1,Math.min(UPSTREAM_TIMEOUT_MS,remaining()))});
            const headers=response.headers(),headerBytes=Object.entries(headers).reduce((n,[k,v])=>n+k.length+String(v).length,0);
            if((response.status()>=300&&response.status()<400)||headerBytes>32768||Number(headers['content-length']??0)>8*1024*1024){deny();await abort(route);return;}
            // APIRequestContext buffers before these checks. The container's
            // memory ceiling and outer deadline remain the hard body bounds.
            if(response.body&&(await response.body()).length>8*1024*1024){deny();await abort(route);return;}
            if(denied){await abort(route);return;}
            await route.fulfill({response});
        }catch{deny();await abort(route);}
        finally{if(response)await response.dispose().catch(()=>{});}
    };
    await context.route('**/*',route=>{const task=handle(route);pending.add(task);task.then(()=>pending.delete(task),()=>{pending.delete(task);deny();});return task;});
    return {check,async finish(){
        // Fence before waiting: queued callbacks can never start new upstreams.
        // A result is returned only after all admitted callbacks settled.
        fenced=true;check();if(!pending.size)return;
        let timer;const timeout=new Promise(resolve=>{timer=setTimer(()=>{deny();resolve();},1000);});
        try{while(pending.size&&!denied)await Promise.race([Promise.allSettled([...pending]),timeout]);check();}
        finally{clearTimer(timer);}
    },bindPage(page){
        if(owned||!page){deny();check();}
        check();owned=page;
        context.on('page',other=>{if(other!==owned){deny();Promise.resolve().then(()=>other.close()).catch(()=>{});}});
    }};
}
