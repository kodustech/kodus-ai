import { evidenceKey, verifyUploadGrant } from '@libs/runtime/api/domain/evidence';
import { FakeEnvironmentRuntime, type ProbeOutcome } from '@libs/runtime/environment';
import { ProbeSchema } from '@libs/runtime/probe';
import type { EvidenceRequest } from '@libs/runtime/protocol';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { InMemoryEvidenceStore } from '../../shared/evidence/file-evidence-store';
import { HmacCanaryVault } from '../canary/canary';
import type { StepRunner } from './ports';
import { replayProbe } from './replay';

const RUN = { runId: '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f', attempt: 1 };
const SECRET = 'dev-only-runtime-evidence-signing-secret-000000';
const step: StepRunner = (async <T>(_name: string, fn: () => Promise<T>) => fn()) as StepRunner;

const probe = ProbeSchema.parse({
    id: 'orders-empty-cart',
    origin: 'agent',
    purpose: 'an empty cart is refused',
    expected: '400',
    compare: ['status'],
    spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', timeoutMs: 1_000 },
});

async function shopClaims(env: FakeEnvironmentRuntime) {
    const ask = (side: 'base' | 'pr') =>
        env.acquire({ organizationId: 'o', environmentId: 'shop', runId: RUN.runId, imageId: 'img-shop-1', ref: { side, sha: side.repeat(20).slice(0, 40) }, consumer: 'runtime', idempotencyKey: side });
    const [base, pr] = [await ask('base'), await ask('pr')];
    return { base: (base as any).claimId as string, pr: (pr as any).claimId as string };
}

/** What a cell with every evidence feature answers: the shop's result plus what the app did, per side. */
function capturingCell(env: FakeEnvironmentRuntime, claims: { base: string; pr: string }, opts: { capture?: boolean } = {}) {
    const asked: Array<{ side: 'base' | 'pr'; stepId: string; evidence?: EvidenceRequest }> = [];
    const inner = env.probe.bind(env);
    env.probe = async (claimId, p, stepId, evidence?) => {
        const side = claimId === claims.base ? 'base' : 'pr';
        asked.push({ side, stepId, ...(evidence ? { evidence } : {}) });
        const r = (await inner(claimId, p, stepId)) as ProbeOutcome;
        if (opts.capture === false || 'code' in r) return r;
        return {
            ...r,
            requests: r.requests.map((q) => ({ ...q, at: 2 })),
            evidence: {
                t0: '2026-11-06T12:00:00.000Z',
                windowMs: 30,
                logs: {
                    lines: 2,
                    truncated: false,
                    tail:
                        side === 'base'
                            ? [{ at: 4, service: 'web', text: 'POST /orders 400 in 3ms' }]
                            : [
                                  { at: 4, service: 'web', text: 'POST /orders 500 in 9ms' },
                                  { at: 5, service: 'web', text: 'TypeError: cart.items is undefined' },
                              ],
                },
                db: { engine: 'postgres', service: 'db', tables: side === 'pr' ? [{ table: 'public.orders', inserted: 1, updated: 0, deleted: 0, rows: 1 }] : [], truncated: false, sample: [{ table: 'public.orders', columns: ['id'], rows: [[1]] }] },
                outbound: { calls: [], truncated: false },
            },
        } as ProbeOutcome;
    };
    return asked;
}

describe('replay evidence (EVIDENCE-CAPTURE-DESIGN step 1)', () => {
    it('asks every round to capture logs, db and outbound, with a grant per artifact bound to that round\'s key', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const asked = capturingCell(env, claims);
        const store = new InMemoryEvidenceStore();
        await replayProbe({
            run: RUN,
            index: 0,
            probe,
            claims,
            pinnedImageId: 'img-shop-1',
            env,
            step,
            evidence: { organizationId: 'o', store, uploads: { baseUrl: 'https://evidence.kodus.test', secret: SECRET } },
        });
        expect(asked.length).toBeGreaterThanOrEqual(3);
        for (const a of asked) {
            expect(a.evidence!.capture).toEqual(['logs', 'db', 'outbound']);
            expect(a.evidence!.uploads!.map((u) => u.type)).toEqual(['logs', 'db']);
            for (const g of a.evidence!.uploads!) {
                const url = new URL(g.url);
                const key = evidenceKey({ organizationId: 'o', runId: RUN.runId, side: a.side, stepId: a.stepId, type: g.type });
                expect(url.pathname).toBe(`/${key}`);
                const q = (k: string) => url.searchParams.get(k)!;
                expect(verifyUploadGrant({ key, contentType: g.contentType, maxBytes: g.maxBytes, exp: Number(q('exp')), nonce: q('nonce'), sig: q('sig'), secret: SECRET })).toBe(true);
            }
        }
        // One nonce per grant: a grant is single use.
        const nonces = asked.flatMap((a) => a.evidence!.uploads!.map((u) => new URL(u.url).searchParams.get('nonce')));
        expect(new Set(nonces).size).toBe(nonces.length);
    });

    it('lines main and the PR up on one clock and marks the first difference; the rows never reach the checkpoint', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        capturingCell(env, claims);
        const store = new InMemoryEvidenceStore();
        const { decision, lanes } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, evidence: { organizationId: 'o', store } });
        expect(decision.verdict).toBe('finding');
        expect(lanes!.base.side).toBe('base');
        expect(lanes!.pr.captured).toEqual({ requests: true, logs: true, db: true, outbound: true });
        expect(lanes!.pr.events.map((e) => e.kind)).toEqual(['request', 'log', 'log', 'db', 'response']);
        // The request's status is the first thing that parts.
        expect(lanes!.firstDifference).toMatchObject({ index: 0, kind: 'request' });
        // The written output (and so the checkpoint) has the table counts, never the rows.
        const out = [...store.objects.values()].map((o) => o.body.toString());
        expect(out.some((b) => b.includes('public.orders'))).toBe(true);
        expect(out.every((b) => !b.includes('"sample"'))).toBe(true);
    });

    it('an older cell captures nothing: the verdict is the same and every block reads not captured', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        capturingCell(env, claims, { capture: false });
        const { decision, lanes } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step });
        expect(decision.verdict).toBe('finding');
        expect(lanes!.pr.captured).toEqual({ requests: false, logs: false, db: false, outbound: false });
        expect(lanes!.pr.events.map((e) => e.kind)).toEqual(['response']);
        expect(lanes!.firstDifference?.kind).toBe('response');
    });

    it('diffs the two answers field by field from the first healthy rounds, values redacted; the verdict does not change', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const inner = env.probe.bind(env);
        env.probe = async (claimId, p, stepId) => {
            const r = (await inner(claimId, p, stepId)) as ProbeOutcome;
            if ('code' in r || !r.http) return r;
            const pr = claimId === claims.pr;
            const body = JSON.stringify({ error: pr ? 'internal' : 'cart is empty', session: { password: pr ? 'p2' : 'p1' }, note: pr ? 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' : 'ok' });
            return { ...r, http: { ...r.http, body } };
        };
        const steps: unknown[] = [];
        const recording: StepRunner = (async <T>(_n: string, fn: () => Promise<T>) => {
            const out = await fn();
            steps.push(out);
            return out;
        }) as StepRunner;
        const { decision, responseDiff } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step: recording });
        expect(decision.verdict).toBe('finding');
        const by = Object.fromEntries(responseDiff!.fields.map((f) => [f.path, f]));
        // The gate's decisive fields come first.
        expect(responseDiff!.fields[0].path).toBe(decision.differingFields.find((f) => f.startsWith('json.')));
        expect(by['json.error']).toEqual({ path: 'json.error', base: '"cart is empty"', pr: '"internal"' });
        expect(by['json.session.password']).toEqual({ path: 'json.session.password', base: '[redacted]', pr: '[redacted]' });
        expect(JSON.stringify(responseDiff)).not.toContain('ghp_0123456789');
        expect(responseDiff!.truncated).toBe(false);
    });

    it('a body that is not JSON shows its first differing line, and its round keeps only a bounded sample', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const inner = env.probe.bind(env);
        env.probe = async (claimId, p, stepId) => {
            const r = (await inner(claimId, p, stepId)) as ProbeOutcome;
            if ('code' in r || !r.http) return r;
            const lines = Array.from({ length: 500 }, (_, i) => (i === 3 ? (claimId === claims.pr ? 'Internal error' : 'Cart is empty') : `line ${i}`));
            return { ...r, http: { ...r.http, body: lines.join('\n') } };
        };
        const steps: any[] = [];
        const recording: StepRunner = (async <T>(_n: string, fn: () => Promise<T>) => {
            const out = await fn();
            steps.push(out);
            return out;
        }) as StepRunner;
        const { responseDiff } = await replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step: recording });
        expect(responseDiff).toEqual({ fields: [{ path: 'line 4', base: '"Cart is empty"', pr: '"Internal error"' }], truncated: false });
        // Only the first healthy round of each side keeps text, and at most 200 lines of it.
        const kept = steps.filter((o) => o?.text);
        expect(kept).toHaveLength(2);
        expect(kept.every((o) => o.text.lines.length === 200 && o.text.truncated)).toBe(true);
    });

    it('a canary in an uploaded artifact is redacted in the store and halts the Run (ADR-043)', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const canaries = new HmacCanaryVault('k').forRun({ runId: RUN.runId, runToken: 't' });
        const store = new InMemoryEvidenceStore();
        const inner = env.probe.bind(env);
        let logsKey = '';
        env.probe = async (claimId, p, stepId) => {
            const side = claimId === claims.base ? 'base' : 'pr';
            const r = (await inner(claimId, p, stepId)) as ProbeOutcome;
            // The cell uploaded a log that carries the seed canary.
            logsKey = evidenceKey({ organizationId: 'o', runId: RUN.runId, side, stepId, type: 'logs' });
            await store.put(logsKey, `app read ${canaries[2].value}`, 'text/plain');
            return { ...r, evidence: { t0: '2026-11-06T12:00:00.000Z', windowMs: 5, refs: [{ type: 'logs', bytes: 40, sha256: 'a'.repeat(64), truncated: false, redactions: 0 }] } } as ProbeOutcome;
        };
        await expect(replayProbe({ run: RUN, index: 0, probe, claims, pinnedImageId: 'img-shop-1', env, step, canaries, evidence: { organizationId: 'o', store } })).rejects.toMatchObject({
            name: 'CanaryLeakError',
            where: 'probe_output',
        });
        expect((await store.get(logsKey))!.body.toString()).toBe('app read [redacted]');
    });
});
