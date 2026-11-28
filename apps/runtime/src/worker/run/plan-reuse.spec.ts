import type { RuntimeRunProjection } from '@libs/runtime/run';

import { planReuseKey, StepPastPlans } from './plan-reuse';

// The same head run again gets the plan its earlier Run accepted (planner-eval.md fix 1, P1).

const key = planReuseKey({ headSha: 'h', baseSha: 'b', environmentId: 'e', entryPoints: ['GET /a'], targets: [{ service: 'app', port: 3000 }], plannerVersion: 'v1' });
const run = (runId: string, over: Partial<RuntimeRunProjection> = {}) =>
    ({ runId, headSha: 'h', baseSha: 'b', environmentId: 'e', verdictState: 'no_regressions', requestedAt: '2026-11-13T01:00:00Z', ...over }) as RuntimeRunProjection;
const accepted = (over: Record<string, unknown> = {}) => ({ probes: [{ entryPoint: 'GET /a' }], tests: [], claims: [], rejected: [], cannotProve: [], explored: 0, reuseKey: key, ...over });
const q = { organizationId: 'o', repositoryId: 'r', prNumber: 1, runId: 'now', headSha: 'h', baseSha: 'b', environmentId: 'e', key };

describe('planReuseKey', () => {
    it('changes with anything the plan was made from: the planner version, the head, the entry points', () => {
        expect(planReuseKey({ headSha: 'h', baseSha: 'b', environmentId: 'e', entryPoints: ['GET /a'], targets: [{ service: 'app', port: 3000 }], plannerVersion: 'v2' })).not.toBe(key);
        expect(planReuseKey({ headSha: 'h2', baseSha: 'b', environmentId: 'e', entryPoints: ['GET /a'], targets: [{ service: 'app', port: 3000 }], plannerVersion: 'v1' })).not.toBe(key);
        expect(planReuseKey({ headSha: 'h', baseSha: 'b', environmentId: 'e', entryPoints: ['GET /b'], targets: [{ service: 'app', port: 3000 }], plannerVersion: 'v1' })).not.toBe(key);
    });
});

describe('StepPastPlans', () => {
    it("takes the newest earlier Run's accepted plan of the same head and base, from the step it planned in", async () => {
        const steps: Record<string, Array<{ name: string; output: unknown }>> = {
            older: [{ name: 'agent:plan', output: accepted({ cannotProve: ['x: y'] }) }],
            newer: [{ name: 'agent:plan:early', output: { json: { kind: 'planned', plan: accepted() } } }],
        };
        const past = new StepPastPlans({ list: async () => [run('older'), run('newer', { requestedAt: '2026-11-13T02:00:00Z' }), run('now')] }, async (id) => steps[id]);
        expect(await past.find(q)).toEqual({ runId: 'newer', plan: accepted() });
    });

    it('never a plan the checks refused, one made for another key, a Run of another head or one that ended without a verdict', async () => {
        const steps: Record<string, Array<{ name: string; output: unknown }>> = {
            refused: [{ name: 'agent:plan', output: accepted({ rejected: [{ reason: 'probe x: duplicate id' }] }) }],
            otherKey: [{ name: 'agent:plan', output: accepted({ reuseKey: 'old' }) }],
            otherHead: [{ name: 'agent:plan', output: accepted() }],
            errored: [{ name: 'agent:plan', output: accepted() }],
        };
        const past = new StepPastPlans(
            { list: async () => [run('refused'), run('otherKey'), run('otherHead', { headSha: 'h2' }), run('errored', { verdictState: undefined, state: 'errored' })] },
            async (id) => steps[id],
        );
        expect(await past.find(q)).toBeUndefined();
    });
});
