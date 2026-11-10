import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const { runJob } = await import('./run-job.mjs').catch(() => ({ runJob: undefined }));
const input = (evidence) => ({ evidence, steps: [{ goto: '/' }, { screenshot: 'home' }], origin: 'http://app.kody.internal:3000', viewport: { width: 1280, height: 720 }, timeoutMs: 30_000 });
function fakePlaywright({ failAt, requests = [], screenshotFails = false, closeFails = false } = {}) {
    const calls = [];
    const observed = [];
    const page = new EventEmitter();
    const context = new EventEmitter();
    let options;
    let time = 0;
    const network = (spec) => {
        const req = { method: () => spec.method ?? 'GET', url: () => spec.url ?? 'http://app.kody.internal:3000/asset.js', response: async () => ({ status: () => spec.status ?? 200 }) };
        observed.push(req); context.emit('request', req); time += 5;
        if (spec.failed) context.emit('requestfailed', req);
        else if (!spec.pending) { context.emit('response', { request: () => req, status: () => spec.status ?? 200 }); context.emit('requestfinished', req); }
    };
    page.goto = async (url) => { calls.push(['goto', url]); for (const req of requests) network(req); if (failAt === 'goto') throw new Error('net::ERR_FAILED'); };
    page.screenshot = async () => { calls.push(['screenshot']); if (screenshotFails) throw new Error('screenshot failed'); return Buffer.from('png'); };
    page.keyboard = { press: async () => {} };
    page.locator = () => ({ first: () => ({ click: async () => { throw new Error('click failed'); } }) });
    context.clock = { setFixedTime: async () => { calls.push(['clock']); if (failAt === 'clock') throw new Error('clock failed'); } };
    context.routeWebSocket = async()=>{calls.push(['websocket.guard']);};
    context.route = async (_, handler) => { calls.push(['route']); context.routeHandler = handler; if (failAt === 'route') throw new Error('route failed'); };
    context.tracing = {
        start: async () => { calls.push(['trace.start']); if (failAt === 'trace.start') throw new Error('trace failed'); },
        stop: async ({ path }) => { calls.push(['trace.stop']); await writeFile(path, 'trace'); },
    };
    context.newPage = async () => { calls.push(['page']); if (failAt === 'page') throw new Error('page failed'); return page; };
    context.close = async () => {
        calls.push(['context.close']);
        if (closeFails) throw new Error('context close failed');
        if (options.recordVideo) { await mkdir(options.recordVideo.dir); await writeFile(join(options.recordVideo.dir, 'capture.webm'), 'video'); }
        if (options.recordHar) await writeFile(options.recordHar.path, 'har');
    };
    const browser = {
        newContext: async (opts) => { calls.push(['context', opts]); options = opts; if (failAt === 'context') throw new Error('context failed'); return context; },
        close: async () => { calls.push(['browser.close']); },
    };
    const chromium = { launch: async (opts) => { calls.push(['launch', opts]); return browser; } };
    return { chromium, calls, observed, context, page, browser, now: () => time, advance: (n) => { time = n; } };
}
async function execute(f, job = input('lean'), opts = {}) {
    const root = await mkdtemp(join(tmpdir(), 'runner-test-'));
    try {
        assert.equal(typeof runJob, 'function', 'runner must expose orchestration without importing host Playwright');
        const out = await runJob(job, { chromium: f.chromium, now: f.now, workRoot: root, sleep: async (ms) => f.advance(f.now() + ms), ...opts });
        assert.deepEqual(await readdir(root), [], 'temporary artifact directories are removed');
        return out;
    } finally { await rm(root, { recursive: true, force: true }); }
}

test('lean plays the same page with explicit screenshots and no full recording options or files', async () => {
    const lean = fakePlaywright({ requests: [{ status: 201 }] });
    const full = fakePlaywright({ requests: [{ status: 201 }] });
    const a = await execute(lean); const b = await execute(full, input('full'));
    assert.deepEqual(a.result.steps, b.result.steps);
    assert.deepEqual(a.result.network, b.result.network);
    assert.deepEqual(a.files.map(([name]) => name), ['screenshot-0.png']);
    assert.deepEqual(b.files.map(([name]) => name).sort(), ['har.json', 'screenshot-0.png', 'trace.zip', 'video.webm']);
    const leanOptions = lean.calls.find(([name]) => name === 'context')[1];
    const fullOptions = full.calls.find(([name]) => name === 'context')[1];
    assert.equal(leanOptions.recordHar, undefined); assert.equal(leanOptions.recordVideo, undefined);
    assert.ok(fullOptions.recordHar); assert.ok(fullOptions.recordVideo);
    assert.ok(!lean.calls.some(([name]) => name.startsWith('trace.')));
    assert.equal(leanOptions.serviceWorkers, 'block'); assert.equal(leanOptions.acceptDownloads, false);
    assert.equal(a.result.networkComplete, true); assert.equal(a.result.networkTruncated, false);
    assert.deepEqual(a.result.network, [{ method: 'GET', url: 'http://app.kody.internal:3000/asset.js', at: 0, complete: true, status: 201, ms: 5 }]);
});

test('omitting evidence keeps full and lean retains failure screenshots and closes resources', async () => {
    const full = await execute(fakePlaywright(), input(undefined)); assert.ok(full.files.some(([name]) => name === 'har.json'));
    const f = fakePlaywright({ failAt: 'goto' }); const out = await execute(f);
    assert.equal(out.result.steps[0].ok, false); assert.equal(out.result.steps[0].screenshot, 0);
    assert.deepEqual(out.files.map(([name]) => name), ['screenshot-0.png']);
    assert.deepEqual(f.calls.slice(-2).map(([name]) => name), ['context.close', 'browser.close']);
});

test('network failures and pending requests never get fabricated complete measurements', async () => {
    const out = await execute(fakePlaywright({ requests: [{ failed: true }, { pending: true }, { status: 503 }] }));
    assert.equal(out.result.networkComplete, false); assert.equal(out.result.network.length, 3);
    for (const row of out.result.network.slice(0, 2)) { assert.equal(row.complete, false); assert.equal(row.status, undefined); assert.equal(row.ms, undefined); }
    assert.equal(out.result.network[2].status, 503); assert.equal(out.result.network[2].complete, true);
});

test('network observation is bounded and overflow makes completeness unknown', async () => {
    const out = await execute(fakePlaywright({ requests: Array.from({ length: 205 }, () => ({})) }));
    assert.equal(out.result.network.length, 200); assert.equal(out.result.networkTruncated, true); assert.equal(out.result.networkComplete, false);
});

test('same-origin ordinary assets use zero-redirect fetch in both recording modes', async () => {
    for (const evidence of ['lean','full']) {
        const f=fakePlaywright(),results=[];
        f.page.goto=async()=>f.context.routeHandler({
            request:()=>({url:()=> 'http://app.kody.internal:3000/app.js',frame:()=>({page:()=>f.page})}),
            fetch:async options=>{assert.equal(options.maxRedirects,0);return {status:()=>200,headers:()=>({}),body:async()=>Buffer.from('asset'),dispose:async()=>results.push('dispose')};},
            fulfill:async()=>results.push('fulfill'),abort:async()=>results.push('abort'),
        });
        await execute(f,input(evidence));assert.deepEqual(results,['fulfill','dispose']);
    }
});

for (const failAt of ['context', 'route', 'trace.start', 'page', 'clock']) test(`cleans acquired resources when ${failAt} throws`, async () => {
    const f = fakePlaywright({ failAt });
    await assert.rejects(execute(f, { ...input('full'), clock: '2026-11-08T00:00:00Z' }), /failed/);
    assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'context.close').length, failAt === 'context' ? 0 : 1);
});

test('a failing context cleanup still closes the browser', async () => {
    const f = fakePlaywright({ closeFails: true }); await assert.rejects(execute(f), /context close failed/);
    assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1);
});

test('the deadline closes acquired browser/context when page creation hangs', async () => {
    assert.equal(typeof runJob, 'function');
    let expire;
    const f = fakePlaywright();
    f.context.newPage = () => new Promise(() => {});
    const pending = execute(f, input('lean'), { setTimer: (fn) => { expire = fn; return 1; }, clearTimer: () => {} });
    while (!f.calls.some(([name]) => name === 'route')) await new Promise((resolve) => setImmediate(resolve));
    f.advance(30_001); expire();
    await assert.rejects(pending, /deadline/);
    assert.equal(f.calls.filter(([name]) => name === 'context.close').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1);
});


test('bounded quiescence observes a response finishing after the final page action', async () => {
    const f = fakePlaywright({ requests: [{ pending: true }] }); let waits = 0;
    const out = await execute(f, input('lean'), { sleep: async (ms) => {
        f.advance(f.now() + ms); waits++;
        if (waits === 1) {
            const req = f.observed[0]; f.context.emit('response', { request: () => req, status: () => 204 }); f.context.emit('requestfinished', req);
        }
    } });
    assert.equal(out.result.networkComplete, true); assert.equal(out.result.network[0].status, 204);
    assert.ok(waits > 0); assert.ok(f.now() <= 300);
});

test('a Chromium launch resolving after the deadline is immediately closed', async () => {
    assert.equal(typeof runJob, 'function');
    const f = fakePlaywright(); let resolveLaunch; let expire;
    f.chromium.launch = () => new Promise((resolve) => { resolveLaunch = resolve; });
    const pending = execute(f, input('lean'), { setTimer: (fn) => { expire = fn; return 1; }, clearTimer: () => {} });
    while (!resolveLaunch) await new Promise((resolve) => setImmediate(resolve));
    f.advance(30_001); expire(); await assert.rejects(pending, /deadline/);
    resolveLaunch(f.browser); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.filter(([name]) => name === 'browser.close').length, 1);
    assert.equal(f.calls.filter(([name]) => name === 'context').length, 0);
});

test('elapsed timestamps stay integer milliseconds for the Go decoder', async () => {
    const f = fakePlaywright();
    f.page.goto = async () => {
        const req = { method: () => 'GET', url: () => 'http://app.kody.internal:3000/api' };
        f.advance(1.25); f.context.emit('request', req);
        f.advance(2.5); f.context.emit('response', { request: () => req, status: () => 200 });
        f.advance(3.75); f.context.emit('requestfinished', req);
        f.page.emit('console', { type: () => 'log', text: () => 'ok' });
    };
    const { result } = await execute(f);
    assert.ok(result.steps.every((s) => Number.isInteger(s.startMs) && Number.isInteger(s.endMs)));
    assert.ok(result.console.every((s) => Number.isInteger(s.at)));
    assert.ok(result.network.every((s) => Number.isInteger(s.at) && Number.isInteger(s.ms)));
});
