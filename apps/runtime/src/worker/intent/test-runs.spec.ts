import { evidenceKey, verifyUploadGrant } from '@libs/runtime/api/domain/evidence';
import { FakeEnvironmentRuntime, type ExecRequest } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { InMemoryEvidenceStore } from '../../shared/evidence/file-evidence-store';
import { HmacCanaryVault } from '../canary/canary';
import type { StepRunner } from '../run/ports';
import { runPlannedTests } from './test-runs';

const RUN = { runId: '7d0f3c1e-5b8a-4c2e-9f1d-2a3b4c5d6e7f', attempt: 1 };
const SECRET = 'dev-only-runtime-evidence-signing-secret-000000';
const step: StepRunner = (async <T>(_name: string, fn: () => Promise<T>) => fn()) as StepRunner;
const tests = [{ id: 'orders-spec', path: 'test/orders.e2e-spec.ts', entryPoint: 'POST /orders', command: 'npm test -- orders' }];

async function shopClaims(env: FakeEnvironmentRuntime) {
    const ask = (side: 'base' | 'pr') =>
        env.acquire({ organizationId: 'o', environmentId: 'shop', runId: RUN.runId, imageId: 'img-shop-1', ref: { side, sha: side.repeat(20).slice(0, 40) }, consumer: 'runtime', idempotencyKey: side });
    const [base, pr] = [await ask('base'), await ask('pr')];
    return { base: (base as any).claimId as string, pr: (pr as any).claimId as string };
}

/** A cell with execCast: it uploads the cast with the step's grant and reports its ref. */
function castingCell(env: FakeEnvironmentRuntime, store: InMemoryEvidenceStore, castOf: (side: 'base' | 'pr') => string, claims: { base: string; pr: string }) {
    const asked: Array<{ side: 'base' | 'pr'; req: ExecRequest }> = [];
    const inner = env.exec.bind(env);
    env.exec = async (claimId, req) => {
        const side = claimId === claims.base ? 'base' : 'pr';
        asked.push({ side, req });
        const r = await inner(claimId, req);
        if ('code' in r || !req.evidence?.uploads?.length) return r;
        await store.put(evidenceKey({ organizationId: 'o', runId: RUN.runId, side, stepId: req.stepId, type: 'cast' }), castOf(side), 'text/plain');
        return { ...r, refs: [{ type: 'cast' as const, bytes: 40, sha256: 'a'.repeat(64), truncated: false, redactions: 0 }] };
    };
    return asked;
}

describe('runPlannedTests evidence', () => {
    it('signs one cast grant per side, bound to that exec step, and keeps the cast refs it read back', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const store = new InMemoryEvidenceStore();
        const asked = castingCell(env, store, () => 'PASS orders', claims);
        const [run] = await runPlannedTests({
            run: RUN,
            tests,
            claims,
            env,
            step,
            evidence: { organizationId: 'o', store, uploads: { baseUrl: 'https://evidence.kodus.test', secret: SECRET } },
        });
        expect(asked.map((a) => a.side)).toEqual(['base', 'pr']);
        for (const a of asked) {
            expect(a.req.stepId).toBe(run.stepIds![a.side]);
            expect(a.req.evidence!.capture).toEqual(['cast']);
            const [g] = a.req.evidence!.uploads!;
            expect(g.type).toBe('cast');
            const key = evidenceKey({ organizationId: 'o', runId: RUN.runId, side: a.side, stepId: a.req.stepId, type: 'cast' });
            const url = new URL(g.url);
            expect(url.pathname).toBe(`/${key}`);
            const q = (k: string) => url.searchParams.get(k)!;
            expect(verifyUploadGrant({ key, contentType: g.contentType, maxBytes: g.maxBytes, exp: Number(q('exp')), nonce: q('nonce'), sig: q('sig'), secret: SECRET })).toBe(true);
        }
        expect(run).toMatchObject({ base: 'pass', pr: 'pass', casts: { base: { type: 'cast' }, pr: { type: 'cast' } } });
    });

    it('a canary in an uploaded cast is redacted in the store and halts the Run (ADR-043)', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const canaries = new HmacCanaryVault('k').forRun({ runId: RUN.runId, runToken: 't' });
        const store = new InMemoryEvidenceStore();
        castingCell(env, store, (side) => (side === 'pr' ? `env: ${canaries[1].value}` : 'PASS'), claims);
        await expect(
            runPlannedTests({ run: RUN, tests, claims, env, step, canaries, evidence: { organizationId: 'o', store, uploads: { baseUrl: 'https://evidence.kodus.test', secret: SECRET } } }),
        ).rejects.toMatchObject({ name: 'CanaryLeakError', where: 'exec_output' });
        const cast = [...store.objects.entries()].find(([k]) => k.includes('/pr/'))!;
        expect(cast[1].body.toString()).toBe('env: [redacted]');
    });

    it('asks for nothing without an evidence store', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const asked = castingCell(env, new InMemoryEvidenceStore(), () => 'x', claims);
        const [run] = await runPlannedTests({ run: RUN, tests, claims, env, step });
        expect(asked.every((a) => a.req.evidence === undefined)).toBe(true);
        expect(run.casts).toBeUndefined();
    });
});


describe('Intent tests canonical reset image (#2505)', () => {
    it('passes the same acquired image pin to both internal-test resets', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS);
        const claims = await shopClaims(env);
        const reset = jest.spyOn(env, 'reset');
        const args = { run: RUN, tests, claims, env, step, pinnedImageId: 'img-shop-1' };
        await runPlannedTests(args);
        expect(reset.mock.calls).toEqual([[claims.base, 'img-shop-1'], [claims.pr, 'img-shop-1']]);
    });
});
