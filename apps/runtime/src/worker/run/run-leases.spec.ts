import { type AcquireRequest, type Blocked, FakeEnvironmentRuntime, type LeaseRenewal } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';

import { shopRunRequest } from '../../e2e/fixtures';
import { inMemoryRunDeps } from './in-memory-deps';
import { ClaimLeaseKeeper, Timers } from './lease-keeper';
import type { ClaimLeases } from './ports';
import { runRuntimeRun } from './run-orchestrator';

// The Run keeps each claim leased from that side's boot until it ends (claim.renew
// through the hub), outside the DBOS journal.

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>) =>
    projection.upsert(req.runId, {
        attempt: req.attempt,
        correlationId: req.correlationId,
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        state: 'queued',
        requestedAt: req.requestedAt,
    });

/** Records what the Run asks of the keeper, and when relative to the releases. */
function recordingLeases(log: string[]) {
    const kept: string[][] = [];
    const leases: ClaimLeases = {
        keep: (ids) => {
            kept.push(ids);
            log.push('keep');
            return { stop: () => void log.push('stop') };
        },
    };
    return { leases, kept };
}

describe('a Run keeps its claims leased while it works', () => {
    it('keeps both bound claims from their boots and stops before they are released', async () => {
        const { deps, projection, claims } = inMemoryRunDeps();
        const log: string[] = [];
        const { leases, kept } = recordingLeases(log);
        const release = deps.env.release.bind(deps.env);
        deps.env.release = async (id) => (log.push('release'), release(id));
        const req = shopRunRequest();
        await seed(projection, req);

        const result = await runRuntimeRun(req, { ...deps, leases });

        expect(result.state).toBe('regression');
        const ids = [...claims.claims.values()].sort((a, b) => a.side.localeCompare(b.side)).map((c) => c.claimId);
        // One hold per side, each from its own boot.
        expect(kept).toEqual(expect.arrayContaining([[ids[0]], [ids[1]]]));
        expect(kept).toHaveLength(2);
        // Stopped first: no renewal after the Run gave its claims back.
        expect(log.indexOf('stop')).toBeGreaterThan(log.indexOf('keep'));
        expect(log.indexOf('stop')).toBeLessThan(log.indexOf('release'));
    });

    it('keeps a side leased from its own boot while the other side still waits for room', async () => {
        // The base boots at once; the PR waits 35 min of rounds for room. The base's lease (45 min
        // from its acquire) must be renewed before the PR gets room, not 15 min after both booted.
        let clock = Date.parse('2026-11-07T12:00:00Z');
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date(clock));
        const real = env.acquire.bind(env);
        const log: string[] = [];
        const { leases, kept } = recordingLeases(log);
        let keptWhenPrAdmitted: string[] | undefined;
        const blocked: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'no room' }], capacity: { cellId: 'c' } };
        const start = clock;
        env.acquire = async (r: AcquireRequest) => {
            if (r.ref.side === 'pr' && clock - start < 20 * 60_000) return blocked;
            if (r.ref.side === 'pr') keptWhenPrAdmitted = kept.flat();
            return real(r);
        };
        const { deps, projection, claims } = inMemoryRunDeps({ env });
        deps.now = () => new Date(clock);
        deps.sleep = async (ms) => void (clock += ms);
        const req = shopRunRequest({ requestedAt: new Date(clock).toISOString() });
        await seed(projection, req);

        expect((await runRuntimeRun(req, { ...deps, leases })).state).toBe('regression');
        const base = [...claims.claims.values()].find((c) => c.side === 'base')!;
        expect(keptWhenPrAdmitted).toEqual([base.claimId]);
        expect(kept.flat().sort()).toEqual([...claims.claims.values()].map((c) => c.claimId).sort());
    });

    it('keeps nothing for a Run that could not boot', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const { leases, kept } = recordingLeases([]);
        const req = shopRunRequest({ environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } });
        await seed(projection, req);
        expect((await runRuntimeRun(req, { ...deps, leases })).state).toBe('could_not_boot');
        expect(kept).toHaveLength(0);
    });

    it('a cancelled Run (DBOS cancellation thrown from a step) stops the renewals too', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const log: string[] = [];
        const { leases } = recordingLeases(log);
        class DBOSWorkflowCancelledError extends Error {
            name = 'DBOSWorkflowCancelledError';
        }
        const step = deps.step;
        deps.step = (name, fn) => (name === 'agent:plan' ? Promise.reject(new DBOSWorkflowCancelledError('cancelled')) : step(name, fn));
        const req = shopRunRequest();
        await seed(projection, req);
        await expect(runRuntimeRun(req, { ...deps, leases })).rejects.toThrow('cancelled');
        expect(log).toEqual(['keep', 'keep', 'stop', 'stop']);
    });

    it('a lost cell while renewing does not touch the Run: it reaches its verdict', async () => {
        const { deps, projection } = inMemoryRunDeps();
        // Renewals fire while the agent plans; every one of them fails.
        const fire: Array<() => void> = [];
        const timers: Timers = { setTimeout: (fn) => (fire.push(fn), fire.length), clearTimeout: () => undefined };
        let renewals = 0;
        const leases = new ClaimLeaseKeeper(
            async (): Promise<LeaseRenewal> => {
                renewals++;
                throw new Error('cell lost');
            },
            { timers },
        );
        const step = deps.step;
        deps.step = async (name, fn) => {
            if (name === 'agent:plan') {
                for (let i = 0; i < 3 && fire.length; i++) {
                    fire.shift()!();
                    for (let j = 0; j < 10; j++) await Promise.resolve();
                }
            }
            return step(name, fn);
        };
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, { ...deps, leases });
        expect(renewals).toBeGreaterThan(0);
        expect(result).toMatchObject({ state: 'regression', verdictState: 'regression' });
    });
});
