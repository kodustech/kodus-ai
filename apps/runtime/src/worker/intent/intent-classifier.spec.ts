import type { ProbeVerdict } from '@libs/runtime/run';

import { LlmBudgetExceededError, LlmGateway, LlmRequest } from '../agent/llm-gateway';
import { classifyIntents, downgrade, INTENT_CONCURRENCY, IntentClassifier, IntentContext } from './intent-classifier';
import type { TestRun } from './test-runs';

const finding = (over: Partial<ProbeVerdict> = {}): ProbeVerdict => ({
    probeId: 'orders-empty-cart',
    entryPoint: 'POST /orders',
    verdict: 'finding',
    findingKind: 'behavior_change',
    intent: 'unintended',
    reason: 'stable base, stable PR, and they differ',
    differingFields: ['status'],
    ...over,
});

const preExisting: TestRun = { testId: 'orders-spec', path: 'test/orders.e2e-spec.ts', entryPoint: 'POST /orders', base: 'pass', pr: 'pass' };

const ctx = (over: Partial<IntentContext> = {}): IntentContext => ({
    runId: 'run-1',
    organizationId: 'org-demo',
    runToken: 'fake-run-token',
    diff: [{ path: 'src/orders/orders.controller.ts', patch: '@@ -1 +1 @@\n-a\n+b' }],
    title: 'Return 500 on empty cart',
    description: 'Intentional: the cart check moved to the client.',
    tests: [preExisting],
    ...over,
});

/** Answers every call with the given text, or throws it; records what was sent. */
const llm = (answer: string | Error) => {
    const sent: LlmRequest[] = [];
    const gateway: LlmGateway = {
        complete: async (req) => {
            sent.push(req);
            if (answer instanceof Error) throw answer;
            return { text: answer, usage: { inputTokens: 1, outputTokens: 1 } };
        },
    };
    return { gateway, sent };
};

const INTENDED = '{"intent":"intended","testId":"orders-spec"}';
const direct = (_n: string, fn: () => Promise<any>) => fn();

describe('IntentClassifier', () => {
    it('accepts intended only with a pre-existing test that passed on base and PR for the same entry point', async () => {
        const { gateway, sent } = llm(INTENDED);
        const d = await new IntentClassifier(gateway).classify(finding(), ctx());
        expect(d).toMatchObject({ intent: 'intended', testId: 'orders-spec' });
        // A separate call, task runtime.intent, without the agent's conversation.
        expect(sent[0].task).toBe('runtime.intent');
        expect(sent[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
        expect(sent[0].messages[1].content).not.toContain('observations');
    });

    it('a test added or changed by the PR keeps the finding', async () => {
        const { gateway } = llm(INTENDED);
        const d = await new IntentClassifier(gateway).classify(
            finding(),
            ctx({ diff: [...ctx().diff, { path: 'test/orders.e2e-spec.ts', patch: '+it()' }] }),
        );
        expect(d.intent).toBe('uncertain');
    });

    it('a pre-existing test that already failed on base is not evidence', async () => {
        const { gateway } = llm(INTENDED);
        const d = await new IntentClassifier(gateway).classify(finding(), ctx({ tests: [{ ...preExisting, base: 'fail' }] }));
        expect(d.intent).toBe('uncertain');
    });

    it('a test failing on the PR, not run, or on another entry point is not evidence', async () => {
        const { gateway } = llm(INTENDED);
        const c = new IntentClassifier(gateway);
        expect((await c.classify(finding(), ctx({ tests: [{ ...preExisting, pr: 'fail' }] }))).intent).toBe('uncertain');
        expect((await c.classify(finding(), ctx({ tests: [{ ...preExisting, pr: 'not_run' }] }))).intent).toBe('uncertain');
        expect((await c.classify(finding(), ctx({ tests: [{ ...preExisting, entryPoint: 'GET /orders' }] }))).intent).toBe('uncertain');
    });

    it('intended naming no test, or a test that is not evidence, is uncertain', async () => {
        expect((await new IntentClassifier(llm('{"intent":"intended"}').gateway).classify(finding(), ctx())).intent).toBe('uncertain');
        expect((await new IntentClassifier(llm('{"intent":"intended","testId":"nope"}').gateway).classify(finding(), ctx())).intent).toBe('uncertain');
    });

    it('pr_destabilizes_machine is never intended', async () => {
        const d = await new IntentClassifier(llm(INTENDED).gateway).classify(finding({ findingKind: 'pr_destabilizes_machine' }), ctx());
        expect(d.intent).toBe('uncertain');
    });

    it('LLM error, budget or garbage leaves the finding uncertain', async () => {
        expect((await new IntentClassifier(llm(new Error('503')).gateway).classify(finding(), ctx())).intent).toBe('uncertain');
        expect((await new IntentClassifier(llm(new LlmBudgetExceededError('spent')).gateway).classify(finding(), ctx())).intent).toBe('uncertain');
        expect((await new IntentClassifier(llm('I think it is fine').gateway).classify(finding(), ctx())).intent).toBe('uncertain');
        expect((await new IntentClassifier(llm('{"intent":"success"}').gateway).classify(finding(), ctx())).intent).toBe('uncertain');
    });

    it('rethrows what the caller marks as a security event', async () => {
        class Leak extends Error {}
        const c = new IntentClassifier(llm(new Leak('canary')).gateway, { rethrow: (e) => e instanceof Leak });
        await expect(c.classify(finding(), ctx())).rejects.toBeInstanceOf(Leak);
    });

    it('the classifier can keep unintended', async () => {
        expect((await new IntentClassifier(llm('{"intent":"unintended"}').gateway).classify(finding(), ctx())).intent).toBe('unintended');
    });
});

describe('classifyIntents', () => {
    it('never removes a finding, never changes a verdict, only moves intent toward intended', async () => {
        const verdicts: ProbeVerdict[] = [
            finding(),
            { probeId: 'orders-list', entryPoint: 'GET /orders', verdict: 'not_reproduced', reason: 'same' },
            finding({ probeId: 'p2', intent: 'uncertain' }),
        ];
        const lie = { classify: async () => ({ intent: 'unintended' as const, reason: 'x' }) };
        const out = await classifyIntents({ verdicts, ctx: ctx(), classifier: lie, step: direct });
        expect(out.map((v) => [v.probeId, v.verdict, v.intent])).toEqual([
            ['orders-empty-cart', 'finding', 'unintended'],
            ['orders-list', 'not_reproduced', undefined],
            // Already uncertain: a classifier cannot move it back to unintended.
            ['p2', 'finding', 'uncertain'],
        ]);
    });

    it('a classifier that claims intended without evidence is capped at uncertain', async () => {
        const liar = { classify: async () => ({ intent: 'intended' as const, testId: 'orders-spec', reason: 'trust me' }) };
        const out = await classifyIntents({ verdicts: [finding()], ctx: ctx({ tests: [] }), classifier: liar, step: direct });
        expect(out[0]).toMatchObject({ verdict: 'finding', intent: 'uncertain' });
    });

    it('classifies each finding in its own durable step', async () => {
        const names: string[] = [];
        const step = (n: string, fn: () => Promise<any>) => (names.push(n), fn());
        await classifyIntents({ verdicts: [finding(), finding({ probeId: 'b' })], ctx: ctx(), classifier: new IntentClassifier(llm(INTENDED).gateway), step });
        expect(names).toEqual(['intent:0:orders-empty-cart', 'intent:1:b']);
    });

    it('classifies findings together, INTENT_CONCURRENCY at a time, starting steps in index order', async () => {
        let inFlight = 0;
        let peak = 0;
        const names: string[] = [];
        const slow = {
            classify: async (v: ProbeVerdict) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5));
                inFlight--;
                return { intent: 'unintended' as const, reason: v.probeId };
            },
        };
        const step = (n: string, fn: () => Promise<any>) => (names.push(n), fn());
        const verdicts = Array.from({ length: INTENT_CONCURRENCY + 2 }, (_, i) => finding({ probeId: `p${i}` }));
        const out = await classifyIntents({ verdicts, ctx: ctx(), classifier: slow, step });
        expect(peak).toBe(INTENT_CONCURRENCY);
        expect(names).toEqual(verdicts.map((v, i) => `intent:${i}:${v.probeId}`));
        expect(out.map((v) => v.probeId)).toEqual(verdicts.map((v) => v.probeId));
    });

    it('downgrade is monotonic', () => {
        expect(downgrade(undefined, 'unintended')).toBe('unintended');
        expect(downgrade('unintended', 'uncertain')).toBe('uncertain');
        expect(downgrade('uncertain', 'unintended')).toBe('uncertain');
        expect(downgrade('intended', 'uncertain')).toBe('intended');
    });
});
