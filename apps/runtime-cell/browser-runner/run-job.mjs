// Browser orchestration is separate from the stdin/tar entry point so its
// security and recording policy can be tested without a host browser.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { checkJob, MAX_SCREENSHOTS, playSteps } from './steps.mjs';
import {installNetworkGuard,NetworkPolicyError} from './network-guard.mjs';

const MAX_NETWORK = 200;
const MAX_LINES = 500;
const MAX_TEXT = 2_048;

/** Both modes measure requests directly; a response is complete only after its body finishes. */
function observeNetwork(context, now) {
    const records = [];
    const requests = new WeakMap();
    let truncated = false;
    let stopped = false;
    let activityAt = now();
    let pending = 0;
    const onRequest = (request) => {
        if (stopped) return;
        const method = request.method();
        const url = request.url();
        if (records.length >= MAX_NETWORK || method.length > 16 || url.length > 2_048) { truncated = true; return; }
        const record = { method, url, at: now(), complete: false };
        activityAt = record.at; pending++;
        records.push(record);
        requests.set(request, { record, settled: false });
    };
    const onResponse = (response) => {
        if (stopped) return;
        const tracked = requests.get(response.request());
        activityAt = now();
        const status = response.status();
        if (tracked && Number.isInteger(status) && status >= 100 && status <= 599) tracked.status = status;
    };
    const onFinished = (request) => {
        if (stopped) return;
        const tracked = requests.get(request);
        if (!tracked || tracked.settled) return;
        tracked.settled = true; pending--; activityAt = now();
        if (tracked.status === undefined) return;
        Object.assign(tracked.record, { complete: true, status: tracked.status, ms: Math.max(0, now() - tracked.record.at) });
    };
    // Explicitly retain failure as unknown, even if response headers arrived first.
    const onFailed = (request) => {
        if (stopped) return;
        const tracked = requests.get(request);
        if (tracked && !tracked.settled) { tracked.settled = true; pending--; activityAt = now(); }
        if (tracked) { tracked.record.complete = false; delete tracked.record.status; delete tracked.record.ms; }
    };
    context.on('request', onRequest);
    context.on('response', onResponse);
    context.on('requestfinished', onFinished);
    context.on('requestfailed', onFailed);
    const finish = () => {
        stopped = true;
        context.off('request', onRequest); context.off('response', onResponse);
        context.off('requestfinished', onFinished); context.off('requestfailed', onFailed);
        return { network: records, networkComplete: !truncated && records.every((r) => r.complete), networkTruncated: truncated };
    };
    return { finish, async drain(deadline, sleep) {
        // A short quiet window lets already queued body-completion events arrive.
        // Never wait indefinitely for polling pages or unfinished requests.
        const startedAt = now();
        const until = Math.min(deadline, startedAt + 250);
        while (now() < until) {
            await sleep(Math.min(50, until - now()));
            if (!pending && now() - Math.max(activityAt, startedAt) >= 100) break;
        }
    } };
}

/** One isolated page. The caller owns Chromium injection and the outer process hard deadline. */
export async function runJob(raw, { chromium, now: clock = () => performance.now(), workRoot = '/tmp', log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    const job = checkJob(raw);
    const full = job.evidence === 'full';
    const t0Epoch = Date.now();
    const t0 = clock();
    // Result times are integer milliseconds on the Go side; keep a monotonic clock.
    const now = () => Math.max(0, Math.floor(clock() - t0));
    const work = await mkdtemp(join(workRoot, 'run-'));
    let browser; let context; let networkGuard; let traceStarted = false; let ended = false;
    let steps; let videoStartMs; let network; let finishNetwork;
    const shots = [];
    const consoleLines = [];
    const listeners = [];
    const active = () => { networkGuard?.check(); if (ended || now() >= job.timeoutMs) throw new Error('runner deadline'); };
    let rejectDenied;
    const denied = new Promise((_,reject)=>{rejectDenied=()=>reject(new NetworkPolicyError());});
    let expire;
    const expired = new Promise((_, reject) => { expire = () => { ended = true; reject(new Error('runner deadline')); }; });
    const timer = setTimer(expire, Math.max(1, job.timeoutMs - now()));
    const execute = async () => {
        active();
        const host = new URL(job.origin).hostname;
        browser = await chromium.launch({
            chromiumSandbox: false,
            timeout: Math.max(1, job.timeoutMs - now()),
            args: [
                '--disable-dev-shm-usage',
                `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}`,
                '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run',
                '--disable-features=Translate,OptimizationHints,MediaRouter',
            ],
        });
        // A launch/context resolving after the outer deadline still owns a process to close.
        if (ended) { await browser.close(); browser = undefined; active(); }
        active();
        context = await browser.newContext({
            viewport: job.viewport, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce',
            serviceWorkers: 'block', acceptDownloads: false,
            ...(full ? { recordVideo: { dir: join(work, 'video'), size: job.viewport }, recordHar: { path: join(work, 'har.json'), content: 'embed', mode: 'full' } } : {}),
        });
        if (ended) { await context.close(); context = undefined; active(); }
        active();
        const observed = observeNetwork(context, now);
        finishNetwork = observed.finish;
        if (job.clock) { await context.clock.setFixedTime(new Date(job.clock)); active(); }
        networkGuard=await installNetworkGuard(context,{origin:job.origin,remaining:()=>job.timeoutMs-now(),onDenied:rejectDenied});
        active();
        if (full) { await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); traceStarted = true; active(); }
        const page = await context.newPage(); active();networkGuard.bindPage(page);
        if (full) videoStartMs = now();
        const onConsole = (m) => { if (!ended && consoleLines.length < MAX_LINES) consoleLines.push({ level: m.type().slice(0, 16), text: m.text().slice(0, MAX_TEXT), at: now() }); };
        const onError = (e) => { if (!ended && consoleLines.length < MAX_LINES) consoleLines.push({ level: 'error', text: String(e?.message ?? e).slice(0, MAX_TEXT), at: now() }); };
        page.on('console', onConsole); page.on('pageerror', onError);
        listeners.push(() => { page.off('console', onConsole); page.off('pageerror', onError); });
        const shoot = async () => {
            active();
            if (shots.length >= MAX_SCREENSHOTS) return undefined;
            const n = shots.length;
            const png = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', timeout: Math.max(1, Math.min(10_000, job.timeoutMs - now())) });
            active(); shots.push(png); return n;
        };
        steps = await playSteps({ steps: job.steps, origin: job.origin, page, shoot, now, deadline: job.timeoutMs, checkActive:active });
        active();
        await observed.drain(job.timeoutMs, sleep);
        active();
        network = finishNetwork(); finishNetwork = undefined;
    };
    let output;
    try {
        let failure;
        try { await Promise.race([execute(), expired, denied]); } catch (e) { failure = e; }
        finally {
            ended = true;
            clearTimer(timer);
            if (finishNetwork) finishNetwork();
            for (const remove of listeners) remove();
            if (context && traceStarted && !failure) await context.tracing.stop({ path: join(work, 'trace.zip') }).catch((e) => log('trace.failed', { err: String(e?.message ?? e).slice(0, 200) }));
            try { if (context) await context.close(); } catch (e) { failure ??= e; }
            try { if (browser) await browser.close(); } catch (e) { failure ??= e; }
        }
        networkGuard?.check();
        if (failure) throw failure;
        const files = shots.map((png, i) => [`screenshot-${i}.png`, png]);
        if (full) {
            const videos = await readdir(join(work, 'video')).catch(() => []);
            const webm = videos.find((f) => f.endsWith('.webm'));
            if (webm) files.push(['video.webm', await readFile(join(work, 'video', webm))]);
            for (const name of ['trace.zip', 'har.json']) {
                const data = await readFile(join(work, name)).catch(() => undefined);
                if (data) files.push([name, data]);
            }
        }
        output = { result: { t0Epoch, ...(full ? { videoStartMs } : {}), steps, console: consoleLines, ...network }, files };
    } finally {
        try{await rm(work, { recursive: true, force: true });}
        finally{await networkGuard?.finish();}
    }
    networkGuard?.check();
    return output;
}
