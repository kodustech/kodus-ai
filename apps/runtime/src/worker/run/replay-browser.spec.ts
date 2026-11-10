import { evidenceKey, verifyEvidenceSignature } from '@libs/runtime/api/domain/evidence';
import { FakeEnvironmentRuntime, type ProbeOutcome } from '@libs/runtime/environment';
import { type Probe, ProbeSchema } from '@libs/runtime/probe';
import type { EvidenceRequest } from '@libs/runtime/protocol';
import { type ProbeVerdict, RuntimeRunReportSchema, decideRunVerdict } from '@libs/runtime/run';
import { checkOf, renderReportComment } from '@libs/runtime-publish/domain/render-runtime-comment';
import { VISUAL_CHANGE_ONLY_REASON } from '@libs/runtime/contracts/enums';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { InMemoryEvidenceStore } from '../../shared/evidence/file-evidence-store';
import { HmacCanaryVault } from '../canary/canary';
import type { StepRunner } from './ports';
import { BROWSER_DEFAULT_CLOCK, replayProbe } from './replay';
import { buildReport } from './report';
import { checkUploadedRefs } from './run-evidence';

// Browser probes in replay (ADR-071): the same rounds as an HTTP probe, the
// browser capture with a grant per runner artifact, main's first round as
// the baseline every later round diffs its screenshots against, and the
// verdict on behavior. Pixels alone retain visual evidence without a finding.

const RUN = { runId: '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f', attempt: 1 };
const SECRET = 'dev-only-runtime-evidence-signing-secret-000000';
const step: StepRunner = (async <T>(_name: string, fn: () => Promise<T>) => fn()) as StepRunner;

const probe: Probe = ProbeSchema.parse({
    id: 'orders-page',
    origin: 'agent',
    purpose: 'the orders page lists the seeded orders',
    expected: 'the list shows keyboard',
    compare: ['pixels'],
    spec: {
        kind: 'browser',
        steps: [{ goto: '/' }, { waitFor: 'body[data-state=ready]' }, { screenshot: 'orders' }, { expectText: ['#orders', 'keyboard'] }],
        viewport: { width: 1280, height: 720 },
        timeoutMs: 30_000,
    },
});

async function claimsOf(env: FakeEnvironmentRuntime) {
    const ask = (side: 'base' | 'pr') =>
        env.acquire({ organizationId: 'o', environmentId: 'shop', runId: RUN.runId, imageId: 'img-shop-1', ref: { side, sha: side.repeat(20).slice(0, 40) }, consumer: 'runtime', idempotencyKey: side });
    const [base, pr] = [await ask('base'), await ask('pr')];
    return { base: (base as any).claimId as string, pr: (pr as any).claimId as string };
}

type Variant = { listShows: string; ratio: number };

/** A cell with a browser runner: each round answers the steps, a screenshot uploaded with its grant, and the pixel diff when a baseline came. */
function browserCell(env: FakeEnvironmentRuntime, claims: { base: string; pr: string }, store: InMemoryEvidenceStore, pr: Variant) {
    const asked: Array<{ side: 'base' | 'pr'; stepId: string; probe: Probe; evidence?: EvidenceRequest }> = [];
    env.probe = async (claimId, p, stepId, evidence?) => {
        const side = claimId === claims.base ? 'base' : 'pr';
        asked.push({ side, stepId, probe: p, ...(evidence ? { evidence } : {}) });
        const v = side === 'base' ? { listShows: 'keyboard × 2\nmonitor × 1', ratio: 0 } : pr;
        const passes = v.listShows.includes('keyboard');
        const key = (type: string) => evidenceKey({ organizationId: 'o', runId: RUN.runId, side, stepId, type });
        await store.put(key('screenshot-0'), Buffer.from('png'), 'image/png');
        await store.put(key('har'), JSON.stringify({ log: { entries: [] } }), 'application/json');
        const measured = !!evidence?.baseline?.length;
        if (measured) await store.put(key('pixeldiff-0'), Buffer.from('png'), 'image/png');
        const ref = (type: string) => ({ type, bytes: 3, sha256: 'a'.repeat(64), truncated: false, redactions: 0 }) as const;
        return {
            stepId,
            executor: 'observer',
            imageId: 'img-shop-1',
            vmHealth: 'ok',
            transport: 'ok',
            durationMs: 900,
            requests: [{ method: 'GET', route: '/orders', status: 200, at: 300 }],
            browser: {
                network: [{ method: 'GET', url: 'http://app.kody.internal:3000/orders', status: 200, at: 300, ms: 4 }],
                console: passes ? [] : [{ level: 'warning', text: 'no orders to show', at: 420 }],
                videoStartMs: 100,
                steps: [
                    { index: 0, kind: 'goto', ok: true, startMs: 120, endMs: 300 },
                    { index: 1, kind: 'waitFor', ok: true, startMs: 300, endMs: 400 },
                    { index: 2, kind: 'screenshot', ok: true, startMs: 400, endMs: 450, screenshot: 0 },
                    passes
                        ? { index: 3, kind: 'expectText', ok: true, startMs: 450, endMs: 470, value: v.listShows }
                        : { index: 3, kind: 'expectText', ok: false, startMs: 450, endMs: 5450, value: v.listShows, error: 'mismatch', screenshot: 1 },
                ],
                ...(measured ? { pixels: [{ screenshot: 0, ratio: v.ratio, changed: Math.round(v.ratio * 921_600), total: 921_600, sizeDiffers: false }] } : {}),
            },
            evidence: { t0: '2026-11-07T12:00:00.000Z', windowMs: 900, refs: [ref('screenshot-0'), ref('har'), ...(measured ? [ref('pixeldiff-0')] : [])] },
        } as ProbeOutcome;
    };
    return asked;
}

const evidence = (store: InMemoryEvidenceStore) => ({ organizationId: 'o', store, uploads: { baseUrl: 'http://kodus-runtime-worker:3013', secret: SECRET } });

describe('replay of a browser probe (ADR-071)', () => {
    it('preserves browser proof with lean grants and never authorizes video, trace or HAR', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await claimsOf(env);
        const store = new InMemoryEvidenceStore();
        const asked = browserCell(env, claims, store, { listShows: '', ratio: 0.2 });
        const result = await replayProbe({ run: RUN, index: 0, probe: { ...probe, evidence: 'lean' }, claims, pinnedImageId: 'img-shop-1', env, step, evidence: evidence(store) });
        expect(result.decision).toMatchObject({ verdict: 'finding' });
        expect(result.lanes!.firstStepDifference).toBe(3);
        for (const round of asked) {
            expect(round.probe.evidence).toBe('lean');
            const types = round.evidence!.uploads!.map((grant) => grant.type);
            expect(types).toContain('screenshot-0');
            expect(types).toContain('pixeldiff-0');
            expect(types).not.toContain('video');
            expect(types).not.toContain('trace');
            expect(types).not.toContain('har');
        }
        expect(asked.slice(1).every((round) => round.evidence!.baseline?.length === 1)).toBe(true);
    });

    it('asks for the browser capture with every runner grant, on a fixed clock, and diffs every later round against main\'s first', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await claimsOf(env);
        const store = new InMemoryEvidenceStore();
        const asked = browserCell(env, claims, store, { listShows: 'keyboard × 2\nmonitor × 1', ratio: 0.0002 });
        const { decision } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence: evidence(store) });
        expect(decision.verdict).toBe('not_reproduced');
        const [first, ...later] = asked;
        for (const a of asked) {
            expect(a.evidence!.capture).toEqual(['logs', 'outbound', 'browser']);
            const types = a.evidence!.uploads!.map((u) => u.type);
            expect(types).toEqual(expect.arrayContaining(['logs', 'screenshot-0', 'screenshot-9', 'pixeldiff-0', 'video', 'trace', 'har']));
            expect(types).toHaveLength(24);
            // The page's clock is fixed when the probe sets none.
            expect(a.probe.spec.kind === 'browser' && a.probe.spec.clock).toBe(BROWSER_DEFAULT_CLOCK);
        }
        // The baseline round has nothing to diff against; every later one gets its screenshot of step 2.
        expect(first.side).toBe('base');
        expect(first.evidence!.baseline).toBeUndefined();
        for (const a of later) {
            expect(a.evidence!.baseline).toHaveLength(1);
            const b = a.evidence!.baseline![0];
            expect(b).toMatchObject({ step: 2, screenshot: 0 });
            const url = new URL(b.url);
            const key = evidenceKey({ organizationId: 'o', runId: RUN.runId, side: 'base', stepId: first.stepId, type: 'screenshot-0' });
            expect(url.pathname).toBe(`/${key}`);
            expect(verifyEvidenceSignature({ key, exp: Number(url.searchParams.get('exp')), sig: url.searchParams.get('sig')!, secret: SECRET })).toBe(true);
        }
    });

    it('a screen that changed with the same steps keeps visual evidence without a regression', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await claimsOf(env);
        const store = new InMemoryEvidenceStore();
        browserCell(env, claims, store, { listShows: 'keyboard × 2\nmonitor × 1', ratio: 0.03 });
        const { decision, lanes } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence: evidence(store) });
        expect(decision).toMatchObject({ verdict: 'inconclusive', reason: VISUAL_CHANGE_ONLY_REASON, differingFields: ['pixels.2'] });
        expect(decision.findingKind).toBeUndefined();
        expect(lanes!.firstStepDifference).toBeUndefined();
        const shot = lanes!.pr.browser!.steps[2];
        expect(shot).toMatchObject({ label: 'screenshot orders', screenshot: 'screenshot-0', pixeldiff: 'pixeldiff-0', ratio: 0.03 });
        expect(lanes!.base.browser!.steps[2].screenshot).toBe('screenshot-0');
        expect(lanes!.pr.browser!.videoStartMs).toBe(100);
        expect(lanes!.pr.events.find((e) => e.kind === 'response')!.label).toBe('4/4 steps passed');
    });

    it('a list that renders empty is a finding on the step, which the lanes mark as the first difference', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await claimsOf(env);
        const store = new InMemoryEvidenceStore();
        browserCell(env, claims, store, { listShows: '', ratio: 0.2 });
        const { decision, lanes } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence: evidence(store) });
        expect(decision).toMatchObject({ verdict: 'finding' });
        expect(decision.differingFields).toContain('steps');
        expect(decision.differingFields).not.toContain('pixels.2');
        expect(lanes!.firstStepDifference).toBe(3);
        expect(lanes!.pr.browser!.steps[3]).toMatchObject({ ok: false, error: 'mismatch', label: 'expectText #orders "keyboard"' });
        expect(lanes!.pr.browser!.console[0].text).toBe('no orders to show');
    });

    it('reads the HAR and the trace back for canaries before anyone can open them', async () => {
        const store = new InMemoryEvidenceStore();
        const vault = new HmacCanaryVault('k'.repeat(32));
        const canary = vault.forRun({ runId: RUN.runId, runToken: 'run-token' })[1];
        const at = { runId: RUN.runId, side: 'pr' as const, stepId: '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d' };
        const key = (type: string) => evidenceKey({ organizationId: 'o', ...at, type });
        await store.put(key('har'), JSON.stringify({ log: { entries: [{ request: { url: `http://app.kody.internal:3000/?t=${canary.value}` } }] } }), 'application/json');
        const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]), Buffer.from(`resources/x ${canary.value}`, 'latin1'), Buffer.from([0x80, 0x81])]);
        await store.put(key('trace'), zipBytes, 'application/zip');
        const ref = (type: 'har' | 'trace') => ({ type, bytes: 1, sha256: 'a'.repeat(64), truncated: false, redactions: 0 });
        const checked = await checkUploadedRefs({ organizationId: 'o', store }, at, [ref('har'), ref('trace')], [canary]);
        expect(checked.leaked).toBe(true);
        expect((await store.get(key('har')))!.body.toString('utf8')).not.toContain(canary.value);
        const trace = (await store.get(key('trace')))!.body;
        expect(trace.toString('latin1')).not.toContain(canary.value);
        // The bytes around the canary are kept as they were.
        expect([...trace.subarray(0, 6)]).toEqual([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
        expect([...trace.subarray(trace.length - 2)]).toEqual([0x80, 0x81]);
    });
});

describe('the report of a browser probe (what the PR comment reads)', () => {
    const req = { requestedAt: '2026-11-07T12:00:00.000Z', headSha: 'a'.repeat(40), trigger: 'pull_request' as const };

    async function reportOf(pr: Variant) {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await claimsOf(env);
        const store = new InMemoryEvidenceStore();
        browserCell(env, claims, store, pr);
        const { decision, steps, lanes } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence: evidence(store) });
        const verdict: ProbeVerdict = {
            probeId: probe.id,
            entryPoint: 'GET /',
            via: 'public/app.js',
            verdict: decision.verdict,
            ...(decision.findingKind ? { findingKind: decision.findingKind } : {}),
            reason: decision.reason,
            differingFields: decision.differingFields,
            baseStepIds: steps.filter((x) => x.side === 'base').map((x) => x.stepId),
            prStepIds: steps.filter((x) => x.side === 'pr').map((x) => x.stepId),
            ...(lanes ? { lanes } : {}),
        };
        const outcome = decideRunVerdict({ entryPoints: ['GET /'], probes: [verdict] });
        const report = buildReport({ req, state: outcome.verdictState, verdictState: outcome.verdictState, probes: [verdict], steps, uncovered: outcome.uncoveredEntryPoints });
        expect(RuntimeRunReportSchema.safeParse(report).success).toBe(true);
        return report;
    }

    it('kr-shop#1: steps passed per side, the failing step by its selector and how much of the screen changed, never the page text', async () => {
        const report = await reportOf({ listShows: 'monitor × 1', ratio: 0.013 });
        expect(report.paths[0]).toMatchObject({
            base: { browser: { passed: 4, total: 4 } },
            pr: { browser: { passed: 3, total: 4 } },
            differingFields: expect.arrayContaining(['steps', 'step.3.value']),
            browserStep: { index: 3, kind: 'expectText', target: '#orders', outcome: 'fails_on_pr' },
            pixelDiffPercent: 1.3,
        });
        // What the page held and what the step expected stay on the Run page.
        const json = JSON.stringify(report);
        expect(json).not.toContain('keyboard');
        expect(json).not.toContain('monitor');
    });

    it('a screen that changed with the same steps carries the change and no step', async () => {
        const report = await reportOf({ listShows: 'keyboard × 2\nmonitor × 1', ratio: 0.03 });
        expect(report.paths[0]).toMatchObject({ base: { browser: { passed: 4, total: 4 } }, pr: { browser: { passed: 4, total: 4 } }, pixelDiffPercent: 3 });
        expect(report.paths[0].browserStep).toBeUndefined();
        expect(report.state).toBe('partly_tested');
        expect(checkOf(report)).toMatchObject({ conclusion: 'neutral' });
        const comment = renderReportComment(report, { run: 'https://app.kodus.test/runtime/runs/example' });
        expect(comment).toContain('**Visual change**');
        expect(comment).toContain('Is this appearance change intended?');
        expect(comment).toContain('[Screenshots and video]');
        expect(comment).not.toContain('**Regression**');
    });

    it('a change under the gate\'s threshold is no change', async () => {
        const report = await reportOf({ listShows: 'keyboard × 2\nmonitor × 1', ratio: 0.0002 });
        expect(report.paths[0].verdict).toBe('not_reproduced');
        expect(report.paths[0].pixelDiffPercent).toBeUndefined();
        expect(report.paths[0].browserStep).toBeUndefined();
    });
});
