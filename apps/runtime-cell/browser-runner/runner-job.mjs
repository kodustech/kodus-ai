import {checkJob,JobError} from './steps.mjs';
import {checkExploreRequest} from './explore-job.mjs';
export function parseRunnerJob(raw){
    if(raw?.mode!==undefined){
        if(raw.mode!=='explore'||Object.keys(raw).sort().join(',')!=='mode,origin,request')throw new JobError('invalid runner mode');
        let url;try{url=new URL(raw.origin);}catch{throw new JobError('invalid exploration origin');}
        if(url.protocol!=='http:'||url.hostname!=='app.kody.internal'||url.username||url.password||url.origin!==raw.origin)throw new JobError('invalid exploration origin');
        const request=checkExploreRequest(raw.request);
        return {mode:'explore',origin:raw.origin,request,timeoutMs:request.timeoutMs};
    }
    const job=checkJob(raw);return {mode:'replay',job,timeoutMs:job.timeoutMs};
}

export function runnerDeadlineMs(dispatch){return dispatch.timeoutMs+(dispatch.mode==='explore'?10000:20000);}
