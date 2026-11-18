// Trusted image-build input only. No runtime download, registry or URL override.
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export function assetFor(arch){
    const values={arm64:['arm64','00d291f45e1c4d527b3aa08c70c54c7c3030fde0794f8d4575aaa3ca1680f728'],amd64:['x64','c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379']};
    const value=values[arch];if(!value)throw new Error('unsupported native architecture');
    return {url:'https://github.com/vercel-labs/agent-browser/releases/download/v0.41.2/agent-browser-linux-'+value[0],sha256:value[1],maxBytes:20*1024*1024};
}
export async function downloadVerified(asset,path,{fetch:read=fetch}={}){
    const response=await read(asset.url,{signal:AbortSignal.timeout(60000)});
    if(!response.ok||new URL(response.url).protocol!=='https:')throw new Error('native asset download failed');
    const chunks=[];let size=0;const hash=createHash('sha256');
    for await(const chunk of response.body){size+=chunk.length;if(size>asset.maxBytes)throw new Error('native asset download bound');chunks.push(chunk);hash.update(chunk);}
    if(hash.digest('hex')!==asset.sha256)throw new Error('native asset digest mismatch');
    await writeFile(path,Buffer.concat(chunks),{flag:'wx',mode:0o555});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const root=process.argv[2];if(!root?.startsWith('/'))throw new Error('native output directory required');
    const arch=process.env.TARGETARCH||(process.arch==='x64'?'amd64':process.arch);
    await mkdir(root,{recursive:true});
    await downloadVerified(assetFor(arch),join(root,'agent-browser'));
    await downloadVerified({url:'https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.41.2/LICENSE',sha256:'014bb31e83d5c2e76aea1cc6e82217346ab41362f32cb355ad0f5c10aa0aeaff',maxBytes:32768},join(root,'LICENSE'));
}
