import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
const impl=await import('./download-agent-browser.mjs').catch(()=>({}));
test('both Linux architectures select immutable release asset hashes',()=>{
 assert.equal(typeof impl.assetFor,'function','pinned native asset fetcher is missing');
 assert.equal(impl.assetFor('arm64').sha256,'00d291f45e1c4d527b3aa08c70c54c7c3030fde0794f8d4575aaa3ca1680f728');
 assert.equal(impl.assetFor('amd64').sha256,'c4351f3802ffa5254d8c69f20a52e2fcf56925c6016fcf4203db25a07d811379');
 assert.throws(()=>impl.assetFor('other'));
});
test('download is bounded, hash checked and exclusive before any executable is written',async()=>{
 assert.equal(typeof impl.downloadVerified,'function');
 const root=await mkdtemp(join(tmpdir(),'agent-download-'));const path=join(root,'asset');const bytes=Buffer.from('owned fixture');const sha=createHash('sha256').update(bytes).digest('hex');
 const fixtureFetch=async()=>({ok:true,url:'https://example.invalid/fixture',body:(async function*(){yield bytes})()});
 try{
  await assert.rejects(impl.downloadVerified({url:'https://example.invalid',sha256:'0'.repeat(64),maxBytes:32},path,{fetch:fixtureFetch}));
  await assert.rejects(readFile(path));
  await assert.rejects(impl.downloadVerified({url:'https://example.invalid',sha256:sha,maxBytes:2},path,{fetch:fixtureFetch}));
  await impl.downloadVerified({url:'https://example.invalid',sha256:sha,maxBytes:32},path,{fetch:fixtureFetch});assert.deepEqual(await readFile(path),bytes);
  await assert.rejects(impl.downloadVerified({url:'https://example.invalid',sha256:sha,maxBytes:32},path,{fetch:fixtureFetch}));
 }finally{await rm(root,{recursive:true,force:true})}
});
