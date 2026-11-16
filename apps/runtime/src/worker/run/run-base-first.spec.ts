import { type AcquireRequest, type ClaimProgress, FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { inMemoryRunDeps } from './testing';
import { runRuntimeRun } from './run-orchestrator';

// A cell admits a booting claim at its whole size, so a base and a PR sent at
// once race for its memory; when the PR wins, the base waits for the PR's
// build and the plan (made from the base) cannot overlap it (review P5). The
// base's claim goes first; the PR's follows as soon as the base's started.

const later = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function runWith(env: FakeEnvironmentRuntime) {
    const h = inMemoryRunDeps({ env });
    const req = shopRunRequest();
    await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
    return runRuntimeRun(req, h.deps);
}

describe('the base side is admitted before the PR side', () => {
    it("sends the PR's first acquire once the base's claim started on a cell, not after the base is ready", async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const real = env.acquire.bind(env);
        const at: Record<string, number> = {};
        env.acquire = async (r: AcquireRequest) => {
            at[`${r.ref.side}:sent`] ??= Date.now();
            if (r.ref.side === 'base') {
                // The cell takes the base at once and reports it preparing; it is ready 1.5 s later.
                at['base:started'] = Date.now() + 100;
                await later(1_500);
                at['base:ready'] = Date.now();
            }
            return real(r);
        };
        Object.assign(env, {
            progress: async (q: { idempotencyKey: string }): Promise<ClaimProgress | null> =>
                q.idempotencyKey.includes(':base:') && at['base:started'] !== undefined && Date.now() >= at['base:started']
                    ? { phases: [{ phase: 'fetch', state: 'started', at: new Date().toISOString() }], lines: [], updatedAt: new Date().toISOString() }
                    : null,
        });

        await runWith(env);

        expect(at['pr:sent']).toBeGreaterThanOrEqual(at['base:started']);
        expect(at['pr:sent']).toBeLessThan(at['base:ready']);
    });

    it('sends both at once where the environment reports no progress', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const real = env.acquire.bind(env);
        const sent: string[] = [];
        let baseAnswered = false;
        env.acquire = async (r: AcquireRequest) => {
            sent.push(`${r.ref.side}${baseAnswered ? ':after-base' : ''}`);
            if (r.ref.side === 'base') {
                await later(50);
                baseAnswered = true;
            }
            return real(r);
        };

        await runWith(env);

        expect(sent.slice(0, 2).sort()).toEqual(['base', 'pr']);
    });
});

// kr-kodus-ai#1: main was up at 21:02 and the PR built until
// 21:13; the PR comment said "Starting main and this pull request … usually
// ~2 min" for 13 minutes, because the phase moved only once both were up.
describe('the PR comment while the PR still builds', () => {
    it('says main started as soon as main is up, before the PR is ready', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const real = env.acquire.bind(env);
        let prReadyAt = 0;
        env.acquire = async (r: AcquireRequest) => {
            if (r.ref.side === 'pr') {
                await later(1_000);
                prReadyAt = Date.now();
            }
            return real(r);
        };
        const h = inMemoryRunDeps({ env });
        const published: Array<{ phase: string; at: number; bootMs?: number }> = [];
        const request = h.deps.publisher.request.bind(h.deps.publisher);
        h.deps.publisher.request = async (msg) => {
            if (msg.progress) published.push({ phase: msg.progress.phase, at: Date.now(), bootMs: msg.progress.bootMs });
            return request(msg);
        };
        const req = shopRunRequest();
        await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        await runRuntimeRun(req, h.deps);

        const applying = published.filter((p) => p.phase === 'applying');
        expect(applying).toHaveLength(1);
        expect(applying[0].at).toBeLessThan(prReadyAt);
        expect(applying[0].bootMs).toEqual(expect.any(Number));
    });
});

