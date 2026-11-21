import { type AcquireOptions, type AcquireRequest, FakeEnvironmentRuntime, HARD_EXPIRY_MINUTES, PR_BUILD_READY_TIMEOUT_MINUTES } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { claimIdFor } from '../../shared/claim-id';
import { inMemoryRunDeps } from './testing';
import type { StepRunner } from './ports';
import { runRuntimeRun } from './run-orchestrator';

// One acquire is one durable step that waits for the hub's claim.ready (up to
// 30 min for the PR's build). A worker that restarts during that wait runs the
// step again, and the hub, answering a new round of the same claim, waits a
// fresh ready wait (claim-deadlines.ts readyWaitMs). The time the boot already
// took must count: the step sent again waits only what is left of it.

const MINUTE = 60_000;

class DBOSWorkflowCancelledError extends Error {
    name = 'DBOSWorkflowCancelledError';
}

/** Steps recorded as DBOS records them; a step that threw a cancellation has no checkpoint and runs again. */
function journal(): StepRunner {
    const outputs = new Map<string, unknown>();
    return async (name, fn) => {
        if (outputs.has(name)) return structuredClone(outputs.get(name)) as never;
        const value = await fn();
        outputs.set(name, structuredClone(value));
        return value;
    };
}

describe('an acquire sent again after a restart', () => {
    it('waits only what is left of the ready wait of the boot round the hub already recorded', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const h = inMemoryRunDeps({ env });
        h.deps.step = journal();
        const req = shopRunRequest();
        await h.projection.upsert(req.runId, { state: 'queued', organizationId: req.organizationId, requestedAt: req.requestedAt });
        const roundStart = Date.now() - 20 * MINUTE;
        const real = env.acquire.bind(env);
        const sent: Array<{ side: string; opts?: AcquireOptions }> = [];
        env.acquire = async (r: AcquireRequest, opts?: AcquireOptions) => {
            sent.push({ side: r.ref.side, ...(opts ? { opts } : {}) });
            if (r.ref.side === 'pr' && sent.filter((s) => s.side === 'pr').length === 1) {
                // The hub recorded the PR's boot round 20 minutes ago; then the worker died while it waited.
                await h.claims.record({
                    claimId: claimIdFor(req.organizationId, r.idempotencyKey),
                    cellId: 'cell-1',
                    runId: req.runId,
                    organizationId: req.organizationId,
                    side: 'pr',
                    hardExpiresAt: new Date(roundStart + HARD_EXPIRY_MINUTES.runtime * MINUTE).toISOString(),
                });
                throw new DBOSWorkflowCancelledError('worker restarted');
            }
            return real(r);
        };

        await expect(runRuntimeRun(req, h.deps)).rejects.toBeInstanceOf(DBOSWorkflowCancelledError);
        const resumed = await runRuntimeRun(req, h.deps);

        expect(resumed.state).not.toBe('errored');
        const pr = sent.filter((s) => s.side === 'pr');
        expect(pr).toHaveLength(2);
        // The first send keeps the hub's whole wait; the one after the restart ends where the first round's would have.
        expect(pr[0].opts).toBeUndefined();
        expect(pr[1].opts).toEqual({ readyBy: roundStart + PR_BUILD_READY_TIMEOUT_MINUTES * MINUTE });
    });
});
