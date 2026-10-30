import { jsonSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { DEDUP_SCHEMA } from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';

/**
 * The re-ask after a schema mismatch answered valid JSON inside a markdown
 * fence, and that answer was thrown away: the deterministic repair only ran on
 * the FIRST attempt, so dedup fell into keep-all (prod 2026-09-22: glm-5.3-flash,
 * kimi-k2.6, MiniMax-M3 — text "```json\n{"groups": [], "unique": [0, 1, 2]}\n```").
 */
const responses: string[] = [];
const model = new MockLanguageModelV4({
    doGenerate: async () =>
        ({
            content: [{ type: 'text', text: responses.shift() ?? '' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            warnings: [],
        }) as any,
});
jest.mock('@libs/llm/model-invocation', () => ({
    ...jest.requireActual('@libs/llm/model-invocation'),
    resolveModelConfig: jest.fn(() => ({
        model,
        modelName: 'mock',
        callOptions: {},
        providerOptions: {},
    })),
}));

import { LLM } from '@libs/llm/llm';

const runDedup = () =>
    LLM.run({
        byokConfig: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            apiKey: 'k',
        } as any,
        schema: jsonSchema(DEDUP_SCHEMA as any),
        user: 'dedup these',
        runName: 'code-review-dedup',
    });

describe('LLM.run structured re-ask — deterministic repair', () => {
    beforeEach(() => {
        responses.length = 0;
    });

    it('recovers a fenced but valid object returned by the re-ask', async () => {
        responses.push(
            '{"clusters": []}', // valid JSON, wrong shape → schema-mismatch re-ask
            '```json\n{"groups": [], "unique": [0, 1, 2]}\n```',
        );

        await expect(runDedup()).resolves.toEqual({
            groups: [],
            unique: [0, 1, 2],
        });
        expect(responses).toHaveLength(0); // exactly two model calls
    });

    it('still fails when the re-ask is not a valid object either', async () => {
        responses.push('{"clusters": []}', '```json\n{"clusters": []}\n```');

        await expect(runDedup()).rejects.toThrow();
    });
});
