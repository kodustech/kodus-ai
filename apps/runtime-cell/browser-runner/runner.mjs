// Kody Runtime browser runner (ADR-071). One container per probe round, on
// the claim network, under gVisor, as its own user with a read-only root.
// stdin: the job (steps, viewport, clock, origin, timeoutMs), checked again
// here. stdout: one tar stream with result.json, screenshot-N.png,
// video.webm, trace.zip and har.json in full mode. stderr: the runner's own log lines.
//
// The page may only reach the app's origin: Chromium resolves no other name
// (--host-resolver-rules), every request to another origin is aborted, and
// service workers and downloads are off. The container network is the outer
// lock (the cell's egress refuses this container as a source).

import { chromium } from 'playwright-core';

import { JobError } from './steps.mjs';
import { TAR_END, tarEntry } from './tar.mjs';
import { runJob } from './run-job.mjs';
import { runExplore } from './explore-job.mjs';
import { parseRunnerJob, runnerDeadlineMs } from './runner-job.mjs';

const MAX_JOB_BYTES = 1 << 20;
const log = (event, extra = {}) => process.stderr.write(JSON.stringify({ event, ...extra }) + '\n');

async function readJob() {
    const chunks = [];
    let size = 0;
    for await (const c of process.stdin) {
        size += c.length;
        if (size > MAX_JOB_BYTES) throw new JobError('job too large');
        chunks.push(c);
    }
    return parseRunnerJob(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

async function writeOut(chunks) {
    for (const c of chunks) {
        if (!process.stdout.write(c)) await new Promise((r) => process.stdout.once('drain', r));
    }
}

async function main() {
    const dispatch = await readJob();
    // The cell also kills the container; retain a process ceiling if cleanup or stdout hangs.
    const hard = setTimeout(() => { log('runner.deadline'); process.exit(3); }, runnerDeadlineMs(dispatch));
    hard.unref();
    try {
        if (dispatch.mode === 'explore') {
            const result = await runExplore(dispatch.request, { origin: dispatch.origin, chromium });
            await writeOut([...tarEntry('exploration.json', Buffer.from(JSON.stringify(result))), TAR_END]);
            log('exploration.done', { status: result.status, actionsCompleted: result.actionsCompleted, cliCalls: result.cliCalls });
            return;
        }
        const { result, files } = await runJob(dispatch.job, { chromium, log });
        const chunks = [...tarEntry('result.json', Buffer.from(JSON.stringify(result)))];
        for (const [name, data] of files) chunks.push(...tarEntry(name, data));
        chunks.push(TAR_END);
        await writeOut(chunks);
        log('runner.done', { steps: result.steps.length, failed: result.steps.filter((s) => !s.ok).length, files: files.length });
    } finally { clearTimeout(hard); }
}

main().catch((e) => {
    // A refused job is the probe's fault (exit 2); anything else the runner's (exit 1).
    log(e instanceof JobError ? 'job.refused' : 'runner.failed', { err: String(e?.message ?? e).slice(0, 500) });
    process.exit(e instanceof JobError ? 2 : 1);
});
