import { INTENT_AUTHOR_LIMITS, INTENT_AUTHOR_VERSION } from '@libs/runtime/planner/intent-author';

import { LlmBudgetExceededError, type LlmGateway, type LlmRequest, RecordedLlmGateway } from '../agent/llm-gateway';
import { IntentAuthor } from './intent-author';

const ctx = { runId: 'run-1', organizationId: 'org-1', runToken: 'sealed:v1:x' };
const input = {
    description: 'Caps an order at 10 units.\n\n- `quantity` 11 or more is refused with 400 `at most 10 units per order`.',
    entryPoints: [{ id: 'POST /orders' }],
    target: { service: 'app', port: 3000 },
    // The item the text does not name comes from the planner's request.
    requestTemplates: [{ method: 'POST', path: '/orders', body: { item: 'keyboard', quantity: 1 } }],
};
const answer = JSON.stringify({
    probes: [
        {
            quote: '`quantity` 11 or more is refused with 400 `at most 10 units per order`.',
            source: 'description',
            request: { method: 'POST', path: '/orders', body: { item: 'keyboard', quantity: 11 } },
            assertions: [{ kind: 'status', status: 400 }],
        },
    ],
});

describe('IntentAuthor', () => {
    it('a PR that states nothing is never sent to the model', async () => {
        const calls: LlmRequest[] = [];
        const llm: LlmGateway = { complete: async (r) => (calls.push(r), { text: '{}', usage: { inputTokens: 1, outputTokens: 1 } }) };
        expect(await new IntentAuthor(llm).author({ ...input, description: '  ' }, ctx)).toEqual({ status: 'no_stated_intent', version: INTENT_AUTHOR_VERSION });
        expect(calls).toEqual([]);
    });

    it('one runtime.intent_author turn gives the checked probes and the turn\'s usage', async () => {
        const calls: LlmRequest[] = [];
        const recorded = new RecordedLlmGateway([{ task: 'runtime.intent_author', text: answer, usage: { inputTokens: 900, outputTokens: 120 } }], { maxTokensPerRun: 10_000 });
        const llm: LlmGateway = { complete: (r) => (calls.push(r), recorded.complete(r)) };
        const out = await new IntentAuthor(llm).author(input, ctx);
        expect(calls.map((c) => c.task)).toEqual(['runtime.intent_author']);
        expect(calls[0].messages.map((m) => m.role)).toEqual(['system', 'user']);
        expect(out).toMatchObject({ status: 'authored', version: INTENT_AUTHOR_VERSION, usage: { inputTokens: 900, outputTokens: 120 }, dropped: [] });
        expect(out.status === 'authored' && out.probes.map((p) => [p.probe.id, p.intentAssertions])).toEqual([['intent-1', [{ kind: 'status', status: 400 }]]]);
    });

    it('a model or budget failure leaves the Run without intent probes, never stopped', async () => {
        const llm: LlmGateway = { complete: async () => Promise.reject(new LlmBudgetExceededError('run run-1 spent 200000 tokens')) };
        expect(await new IntentAuthor(llm).author(input, ctx)).toEqual({ status: 'unavailable', version: INTENT_AUTHOR_VERSION, reason: 'intent author unavailable: run run-1 spent 200000 tokens' });
    });

    it('an error the caller marks (the canary detector) stops the Run', async () => {
        const leak = new Error('canary');
        const llm: LlmGateway = { complete: async () => Promise.reject(leak) };
        await expect(new IntentAuthor(llm, { rethrow: (e) => e === leak }).author(input, ctx)).rejects.toBe(leak);
    });

    it('asks for an output budget large enough for 8 compact probes (kr-shop #8 was cut at 8192)', async () => {
        const calls: LlmRequest[] = [];
        const llm: LlmGateway = { complete: async (r) => (calls.push(r), { text: answer, usage: { inputTokens: 1, outputTokens: 1 } }) };
        await new IntentAuthor(llm).author(input, ctx);
        expect(calls[0].maxOutputTokens).toBe(INTENT_AUTHOR_LIMITS.maxOutputTokens);
        expect(INTENT_AUTHOR_LIMITS.maxOutputTokens).toBeGreaterThan(8_192);
    });

    it('an answer that is not the JSON asked for is asked again once, and both turns count', async () => {
        const turns = [
            { task: 'runtime.intent_author' as const, text: '{"probes":[{"quote":"`quantity` 11 or more', usage: { inputTokens: 900, outputTokens: 8_192 } },
            { task: 'runtime.intent_author' as const, text: answer, usage: { inputTokens: 950, outputTokens: 300 } },
        ];
        const calls: LlmRequest[] = [];
        const recorded = new RecordedLlmGateway(turns, { maxTokensPerRun: 100_000 });
        const llm: LlmGateway = { complete: (r) => (calls.push(r), recorded.complete(r)) };
        const out = await new IntentAuthor(llm).author(input, ctx);
        expect(calls).toHaveLength(2);
        expect(calls[1].messages.at(-1)).toMatchObject({ role: 'user' });
        expect(out).toMatchObject({ status: 'authored', usage: { inputTokens: 1_850, outputTokens: 8_492 } });
        expect(out.status === 'authored' && out.probes).toHaveLength(1);
    });

    it('a second answer that is still not JSON stops there: no probe, never a third turn', async () => {
        const calls: LlmRequest[] = [];
        const llm: LlmGateway = { complete: async (r) => (calls.push(r), { text: 'I would test the quote.', usage: { inputTokens: 10, outputTokens: 5 } }) };
        const out = await new IntentAuthor(llm).author(input, ctx);
        expect(calls).toHaveLength(2);
        expect(out).toMatchObject({ status: 'authored', probes: [], dropped: [{ reason: 'the answer is not the JSON object asked for' }], usage: { inputTokens: 20, outputTokens: 10 } });
    });
});
