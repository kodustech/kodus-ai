import { existsSync } from 'node:fs';
import { join } from 'node:path';

const load = () => {
    const mapper = existsSync(join(__dirname, 'model-turn-frames.ts'))
        ? require('./model-turn-frames')
        : undefined;
    expect(mapper).toBeDefined();
    return mapper;
};
const scope = {
    runId: '11111111-1111-4111-8111-111111111111',
    attempt: 1,
    turnId: '22222222-2222-4222-8222-222222222222',
};
const options = () => ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'data only' }] }],
    tools: [
        {
            type: 'function',
            name: 'submit_plan',
            inputSchema: { type: 'object' },
            description: 'submit',
        },
    ],
    toolChoice: { type: 'auto' },
    maxOutputTokens: 1000,
});

describe('pure SDK model-turn mapping', () => {
    it('round-trips a supported SDK call without adding a model, key or execution callback', () => {
        const m = load(),
            frame = options();
        const request = m.toModelTurnRequest(scope, frame);
        expect(m.toSdkModelTurnCall(request)).toEqual(frame);
        expect(JSON.parse(JSON.stringify(request))).toEqual(request);
        expect(request).not.toHaveProperty('apiKey');
    });

    it('keeps unsafe finish reasons and raw arguments, and does not turn missing usage into zero', () => {
        const m = load(),
            request = m.toModelTurnRequest(scope, options());
        const generation = {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: 'call1',
                    toolName: 'submit_plan',
                    input: ' { "probes": [] } ',
                },
            ],
            finishReason: { unified: 'length', raw: 'max_tokens' },
            usage: { reported: false },
            warnings: [{ type: 'other', message: 'not measured' }],
        };
        const mapped = m.toSdkModelTurnResult(request, {
            v: 1,
            scope,
            generation,
            budget: { remainingTokens: 1000, usageBasis: 'reservation' },
        });
        expect(mapped.generation.content).toEqual(generation.content);
        expect(mapped.generation.finishReason).toEqual(generation.finishReason);
        expect(mapped.generation.warnings).toEqual(generation.warnings);
        expect(mapped.generation.usage.inputTokens.total).toBeUndefined();
        expect(mapped.generation.usage.outputTokens.total).toBeUndefined();
        expect(mapped.usageReported).toBe(false);
        expect(mapped.budget.usageBasis).toBe('reservation');
    });

    it('refuses unsupported SDK options instead of dropping provider configuration or attachments', () => {
        const m = load();
        expect(() =>
            m.toModelTurnRequest(scope, {
                ...options(),
                providerOptions: { apiKey: 'forbidden' },
            }),
        ).toThrow();
        expect(() =>
            m.toModelTurnRequest(scope, {
                ...options(),
                prompt: [
                    {
                        role: 'user',
                        content: [{ type: 'file', data: 'unsupported' }],
                    },
                ],
            }),
        ).toThrow();
    });

    it('retains measured input when the provider has not reported output usage', () => {
        const m = load(),
            request = m.toModelTurnRequest(scope, options());
        const response = {
            v: 1,
            scope,
            generation: {
                content: [],
                finishReason: { unified: 'stop' },
                usage: {
                    reported: true,
                    inputTokens: { total: 12, cacheRead: 4 },
                    outputTokens: {},
                },
                warnings: [],
            },
            budget: { remainingTokens: 1000, usageBasis: 'reservation' },
        };
        const mapped = m.toSdkModelTurnResult(request, response);
        expect(mapped.generation.usage.inputTokens).toMatchObject({
            total: 12,
            cacheRead: 4,
        });
        expect(mapped.generation.usage.outputTokens.total).toBeUndefined();
        expect(mapped.usageReported).toBe(true);
    });
});
