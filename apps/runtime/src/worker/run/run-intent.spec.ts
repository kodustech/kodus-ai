import { FakeEnvironmentRuntime, type FakeEnvironment } from '@libs/runtime/environment';
import { pullRequestRunView } from '@libs/runtime/api/domain/pull-request-runs';
import { RuntimeRunReportSchema } from '@libs/runtime/run/run-report';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import shopTurns from '../agent/fixtures/shop-orders.json';
import type { RecordedTurn } from '../agent/llm-gateway';
import { runRuntimeRun } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

// The intent oracle in a Run (docs/runtime/intent-oracle.md): the intent
// author writes probes from the PR's description before the replay, they run
// on base and PR through the same gate as the plan's, and what they find
// never fails the check on its own.

const json = (status: number, body: unknown) => ({ http: { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });
const order1 = { id: 1, item: 'keyboard', quantity: 2 };
const order2 = { id: 2, item: 'monitor', quantity: 1 };

/** kr-shop #11/#12 on the fake cell: GET /orders/1 and /orders/2 gain unitPrice and total on the PR. */
function shopWith(answers: { order1Pr: unknown; order2Pr?: unknown }): FakeEnvironmentRuntime {
    const shop: FakeEnvironment = {
        ...SCENARIOS.shop,
        probes: {
            'order-1': { base: () => json(200, order1), pr: () => json(200, answers.order1Pr) },
            'order-2': { base: () => json(200, order2), pr: () => json(200, answers.order2Pr ?? order2) },
            'intent-1': { base: () => json(200, order2), pr: () => json(200, answers.order2Pr ?? order2) },
        },
    };
    return new FakeEnvironmentRuntime({ ...SCENARIOS, shop }, () => new Date());
}

const DIFF = [
    {
        path: 'src/orders/orders.controller.ts',
        patch: '@@ -4,1 +4,2 @@\n     one() {\n+        return 1;',
        content: "@Controller('orders')\nexport class A {\n    @Get(':id')\n    one() {\n        return 1;\n    }\n}",
    },
];
const DESCRIPTION = "`GET /orders/:id` also returns the order's price.\n\n- `unitPrice` comes from the price list (`keyboard` 50, `monitor` 200).\n- `total` is `unitPrice × quantity`.";

const plannedOrder = (id: string, path: string) => ({
    entryPoint: 'GET /orders/:id',
    assertions: { kind: 'http', status: 200 },
    probe: { id, purpose: id, expected: '200', compare: ['status', 'json'], spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'GET', path, timeoutMs: 30_000 } },
});
const plan = (path = '/orders/1', more: Array<ReturnType<typeof plannedOrder>> = []): RecordedTurn => ({
    task: 'runtime.plan',
    text: JSON.stringify({
        probes: [plannedOrder('order-1', path), ...more],
        claims: [],
        cannotProve: [],
    }),
    usage: { inputTokens: 1_000, outputTokens: 200 },
});
const authored = (path: string, expr = '$.unitPrice * $.quantity'): RecordedTurn => ({
    task: 'runtime.intent_author',
    text: JSON.stringify({
        probes: [{ quote: '`total` is `unitPrice × quantity`.', source: 'description', request: { method: 'GET', path }, assertions: [{ kind: 'computed', path: '$.total', expr }] }],
    }),
    usage: { inputTokens: 700, outputTokens: 90 },
});
const classified: RecordedTurn = { task: 'runtime.intent', text: '{"intent":"unintended"}', usage: { inputTokens: 600, outputTokens: 10 } };

function harness(env: FakeEnvironmentRuntime, turns: RecordedTurn[], over: Parameters<typeof shopRunRequest>[0] = {}) {
    const h = inMemoryRunDeps({ env, turns: [shopTurns[0] as RecordedTurn, ...turns] });
    const req = shopRunRequest({ diff: DIFF, ...over, pullRequest: { ...shopRunRequest().pullRequest, description: DESCRIPTION, ...(over.pullRequest ?? {}) } });
    const steps: string[] = [];
    const step = h.deps.step;
    h.deps.step = (name, fn) => (steps.push(name), step(name, fn));
    const tasks: string[] = [];
    const complete = h.llm.complete.bind(h.llm);
    h.llm.complete = (r) => (tasks.push(r.task), complete(r));
    return { ...h, req, steps, tasks };
}

const seed = (h: ReturnType<typeof harness>) =>
    h.projection.upsert(h.req.runId, {
        attempt: h.req.attempt,
        correlationId: h.req.correlationId,
        organizationId: h.req.organizationId,
        teamId: h.req.teamId,
        repositoryId: h.req.repository.id,
        repositoryName: h.req.repository.name,
        prNumber: h.req.pullRequest.number,
        headSha: h.req.pullRequest.headSha,
        baseSha: h.req.pullRequest.baseSha,
        environmentId: h.req.environment.environmentId,
        imageId: h.req.environment.imageId,
        state: 'queued',
        requestedAt: h.req.requestedAt,
    });

const reportOf = (published: any[]) => published.filter((p) => p.kind === 'comment' && !p.progress).at(-1)?.report;

describe('intent probes in a Run (docs/runtime/intent-oracle.md)', () => {
    it('an intent probe whose request answers another status on the PR carries the status change, and an equal status carries none', async () => {
        const shop: FakeEnvironment = {
            ...SCENARIOS.shop,
            probes: {
                'order-1': { base: () => json(200, order1), pr: () => json(200, order1) },
                'intent-1': { base: () => json(200, order2), pr: () => json(500, { error: 'internal' }) },
            },
        };
        const h = harness(new FakeEnvironmentRuntime({ ...SCENARIOS, shop }, () => new Date()), [plan(), authored('/orders/2')]);
        await seed(h);
        await runRuntimeRun(h.req, h.deps);
        const probes = (await h.projection.get(h.req.runId))!.probes!;
        const intent = probes.find((p) => p.probeId === 'intent-1')!;
        expect(intent.statusChange).toEqual({ base: 200, pr: 500 });
        expect(pullRequestRunView({ ...(await h.projection.get(h.req.runId))!, findings: [{ ...intent, verdict: 'finding', intent: 'unintended' }] } as any).firstRegression).toMatchObject({ status: { base: 200, pr: 500 } });

        const same = harness(shopWith({ order1Pr: order1, order2Pr: { ...order2, unitPrice: 200, total: 150 } }), [plan(), authored('/orders/2')]);
        await seed(same);
        await runRuntimeRun(same.req, same.deps);
        expect((await same.projection.get(same.req.runId))!.probes!.find((p) => p.probeId === 'intent-1')).not.toHaveProperty('statusChange');
    });

    it("an intent probe of its own request runs on both sides as its own steps, and its mismatch never fails the check (kr-shop #11)", async () => {
        const h = harness(shopWith({ order1Pr: order1, order2Pr: { ...order2, unitPrice: 200, total: 150 } }), [plan(), authored('/orders/2')]);
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'no_regressions', conclusion: 'success', title: 'No regressions in what was tested · 1 not what the PR describes' });
        expect(h.steps.filter((s) => s === 'intent:author')).toHaveLength(1);
        // After the plan's one probe: index 1, both sides, as many rounds as the gate asked.
        expect(h.steps.filter((s) => s.startsWith('probe:1:intent-1:base:'))).toEqual(['probe:1:intent-1:base:1', 'probe:1:intent-1:base:2']);
        expect(h.steps.some((s) => s.startsWith('probe:1:intent-1:pr:'))).toBe(true);
        expect(h.tasks.filter((t) => t === 'runtime.intent_author')).toHaveLength(1);
        const probes = (await h.projection.get(h.req.runId))!.probes!;
        expect(probes.find((p) => p.probeId === 'intent-1')).toMatchObject({
            verdict: 'intent_mismatch',
            source: 'intent',
            statedIntents: [{ probeId: 'intent-1', quote: '`total` is `unitPrice × quantity`.', source: 'description', request: 'GET /orders/2', assertions: 1, held: 0, failures: [{ expected: '$.total = $.unitPrice * $.quantity = 200', received: '150' }] }],
        });
        expect(reportOf(h.published).intent).toMatchObject({
            state: 'checked',
            assertions: 1,
            held: 0,
            mismatches: [{ probeId: 'intent-1', request: 'GET /orders/2', quote: '`total` is `unitPrice × quantity`.', source: 'description', assertion: '$.total == $.unitPrice * $.quantity', expected: '$.total = $.unitPrice * $.quantity = 200', received: '150' }],
            described: [],
        });
        expect((await h.projection.get(h.req.runId))!.intentChecks).toMatchObject({ state: 'checked', probes: 1, dropped: 0 });
        expect(RuntimeRunReportSchema.safeParse(reportOf(h.published)).success).toBe(true);
    });

    it("an intent probe of the planner's request explains its difference: a described change, no second replay (kr-shop #12)", async () => {
        const h = harness(shopWith({ order1Pr: { ...order1, unitPrice: 50, total: 100 } }), [plan(), authored('/orders/1')]);
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'no_regressions', conclusion: 'success', title: 'No regressions in what was tested · 1 described change' });
        expect(h.steps.some((s) => s.includes(':intent-1:'))).toBe(false);
        expect(h.tasks).not.toContain('runtime.intent');
        const probes = (await h.projection.get(h.req.runId))!.probes!;
        expect(probes.map((p) => [p.probeId, p.verdict])).toEqual([['order-1', 'described_change']]);
        expect(reportOf(h.published).intent).toMatchObject({ state: 'checked', assertions: 1, held: 1, mismatches: [], described: [{ probeId: 'order-1', quote: '`total` is `unitPrice × quantity`.' }] });
    });

    it("the same request with the bug keeps the planner's regression and records the mismatch beside it (kr-shop #11)", async () => {
        const h = harness(shopWith({ order1Pr: { ...order1, unitPrice: 50, total: 52 } }), [plan(), authored('/orders/1'), classified]);
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'regression', conclusion: 'failure', title: '1 regression · 1 not what the PR describes' });
        const [p] = (await h.projection.get(h.req.runId))!.probes!;
        expect(p).toMatchObject({ probeId: 'order-1', verdict: 'finding', statedIntents: [{ held: 0, failures: [{ received: '52' }] }] });
    });

    it("a rule over response fields written for order 1 explains order 2's planned difference too (kr-shop #12)", async () => {
        const priced = (o: typeof order1, unitPrice: number) => ({ ...o, unitPrice, total: unitPrice * o.quantity });
        const h = harness(shopWith({ order1Pr: priced(order1, 50), order2Pr: priced(order2, 200) }), [plan('/orders/1', [plannedOrder('order-2', '/orders/2')]), authored('/orders/1')]);
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'no_regressions', conclusion: 'success', title: 'No regressions in what was tested · 2 described changes' });
        const probes = (await h.projection.get(h.req.runId))!.probes!;
        expect(probes.map((p) => [p.probeId, p.verdict])).toEqual([['order-1', 'described_change'], ['order-2', 'described_change']]);
    });

    it('a rule copied from one example never flags another request of the route: it only fails to explain it', async () => {
        const priced = (o: typeof order1, unitPrice: number) => ({ ...o, unitPrice, total: unitPrice * o.quantity });
        const h = harness(shopWith({ order1Pr: priced(order1, 50), order2Pr: priced(order2, 200) }), [plan('/orders/1', [plannedOrder('order-2', '/orders/2')]), authored('/orders/1', '$.unitPrice * 2'), classified]);
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'regression', title: '1 regression · 1 described change' });
        const [first, second] = (await h.projection.get(h.req.runId))!.probes!;
        expect(first).toMatchObject({ probeId: 'order-1', verdict: 'described_change' });
        expect(second).toMatchObject({ probeId: 'order-2', verdict: 'finding' });
        expect(second.statedIntents).toBeUndefined();
    });

    it("hands the author the planner's requests to the diff's routes as templates, never what the planner expected (kr-shop #7)", async () => {
        const h = harness(shopWith({ order1Pr: order1 }), [plan(), authored('/orders/2')]);
        const author = h.deps.intentAuthor!;
        const inputs: any[] = [];
        h.deps.intentAuthor = { author: (input, ctx) => (inputs.push(input), author.author(input, ctx)) };
        await seed(h);
        await runRuntimeRun(h.req, h.deps);
        expect(inputs[0].requestTemplates).toEqual([{ method: 'GET', path: '/orders/1' }]);
        expect(inputs[0]).not.toHaveProperty('diff');
    });

    it('an org that turned intent checks off spends no turn on them', async () => {
        const h = harness(shopWith({ order1Pr: order1 }), [plan(), authored('/orders/2')], { intentChecks: false });
        await seed(h);
        await runRuntimeRun(h.req, h.deps);
        expect(h.tasks).not.toContain('runtime.intent_author');
        expect(h.steps).not.toContain('intent:author');
        expect((await h.projection.get(h.req.runId))!.intentChecks).toEqual({ state: 'off', probes: 0, dropped: 0 });
        expect(reportOf(h.published).intent).toMatchObject({ state: 'off' });
    });

    it('a PR that describes nothing spends no turn and says only the base comparison ran', async () => {
        const h = harness(shopWith({ order1Pr: order1 }), [plan()], { pullRequest: { ...shopRunRequest().pullRequest, description: '' } });
        await seed(h);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result.state).toBe('no_regressions');
        expect(h.tasks).not.toContain('runtime.intent_author');
        expect(reportOf(h.published).intent).toEqual({ state: 'no_stated_intent', assertions: 0, held: 0, mismatches: [], described: [] });
    });
});
