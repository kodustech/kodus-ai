import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunPlanRequest } from '@libs/runtime/contracts/run-plan';
import * as apiPlanner from '../api/application/test-planner/test-planner.agent';
import * as apiReader from '../api/application/recipe-author/repo-reader';

const request: RunPlanRequest = {
    runId: '11111111-1111-4111-8111-111111111111', round: 0,
    entryPoints: [{ id: 'GET /orders', kind: 'http_route' }],
    changedPaths: ['src/orders.ts'], diff: '--- src/orders.ts\n@@ -1 +1 @@\n-return 400\n+return 500',
    targets: [{ service: 'web', port: 3000, kind: 'http' }], execLeft: 1, observations: [],
};
const probe = {
    id: 'empty-orders', purpose: 'empty orders are rejected', expected: '400', compare: ['status', 'json'],
    spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path: '/orders', timeoutMs: 1000 },
};
const submitted = { probes: [{ entryPoint: 'GET /orders', probe, assertions: { kind: 'http', status: 400 } }], tests: [], claims: [], cannotProve: [] };

function reader(files: Record<string, string>): apiReader.RepoReader {
    return { list: async () => Object.keys(files), read: async path => files[path] ?? null };
}

async function scriptedPlan(planner: typeof apiPlanner) {
    const answers: Record<string, unknown> = {};
    const runner: AgentRunner = {
        run: async (spec, _input, ctx) => {
            answers.limits = { steps: spec.maxSteps, tokens: planner.TEST_PLANNER_LIMITS.maxTokens, reads: planner.TEST_PLANNER_LIMITS.reads };
            const tool = (name: string, input: unknown) => spec.tools.get(name)!.execute(input, ctx);
            answers.search = await tool('search_code', { text: 'orders', path: '' });
            answers.base = await tool('read_file', { path: 'src/orders.ts' });
            answers.head = await tool('read_file', { path: 'src/orders.ts', at: 'head' });
            answers.secret = await tool('read_file', { path: '.env' });
            answers.escape = await tool('read_file', { path: '../outside' });
            answers.submit = await tool(planner.SUBMIT_PLAN_TOOL, submitted);
            return { runId: ctx.runId, agentId: spec.id, status: 'completed', steps: [], artifacts: [], usage: { inputTokens: 321, outputTokens: 45 }, trace: [] };
        },
    };
    const base = reader({ 'src/orders.ts': 'return orders(400);\n', '.env': 'API_KEY=fixture-secret\n' });
    const head = reader({ 'src/orders.ts': 'return orders(500);\n' });
    const result = await planner.planTests({ runner, base, head }, { runId: request.runId, repositoryName: 'acme/shop', baseSha: 'a'.repeat(40), request });
    return { result, answers };
}

describe('planner extraction behavior and compatibility', () => {
    it('preserves the golden read/search/submit result and API export identities without calling a model', async () => {
        const before = await scriptedPlan(apiPlanner);
        expect(before.result).toMatchObject({ status: 'planned', plan: submitted, rejected: [], usage: { inputTokens: 321, outputTokens: 45 }, steps: 0, runStatus: 'completed' });
        expect(before.answers.limits).toEqual({ steps: 12, tokens: 60_000, reads: 30 });
        expect(before.answers.submit).toEqual({ output: 'Accepted.' });
        expect(before.answers.escape).toEqual({ output: 'the path leaves the repository', isError: true });
        expect(JSON.stringify(before.answers)).not.toContain('fixture-secret');
        expect(JSON.stringify(before.answers.base)).toContain('orders(400)');
        expect(JSON.stringify(before.answers.head)).toContain('orders(500)');
        expect(JSON.stringify(before.answers.search)).toContain('src/orders.ts:1:');
        const core = existsSync(join(__dirname, 'index.ts')) ? require('./index') : undefined;
        expect(core).toBeDefined();
        expect(core.planTests).toBe(apiPlanner.planTests);
        expect(core.RepoPathError).toBe(apiReader.RepoPathError);
        expect(await scriptedPlan(core)).toEqual(before);
    });
});
