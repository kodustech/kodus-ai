jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));
import { MockLanguageModelV3 } from 'ai/test';
import { runAgentLoopCall } from './agent-loop-call';
import { resolveModelConfig } from './model-invocation';

function scripted() {
    const generate = jest.fn(async (_options: any) => ({
        content: [{ type: 'text', text: 'done' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
            inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: 0,
                cacheWrite: 0,
            },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
        },
        warnings: [],
    }));
    const model = new MockLanguageModelV3({ doGenerate: generate } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: { maxOutputTokens: 1000 },
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    return generate;
}
describe('optional per-raw-call budget lease', () => {
    it('reserves before a raw call, lowers the provider output cap and settles the reported raw usage', async () => {
        const generate = scripted();
        const finish = jest.fn();
        const before = jest.fn(async (_call: any) => ({
            maxOutputTokens: 7,
            finish,
        }));
        await runAgentLoopCall({
            runName: 'test',
            messages: [{ role: 'user', content: 'data' }],
            loop: { tools: {}, maxSteps: 1, modelCallBudget: { before } },
        } as any);
        expect(before).toHaveBeenCalledTimes(1);
        expect(before).toHaveBeenCalledWith(
            expect.objectContaining({ modelId: 'mock-model-id' }),
        );
        expect(generate).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 7 }),
        );
        expect(finish).toHaveBeenCalledWith(
            expect.objectContaining({
                outcome: 'completed',
                usage: expect.objectContaining({
                    inputTokens: expect.objectContaining({ total: 10 }),
                }),
            }),
        );
    });
    it('never invokes the provider when an attempt lease is refused', async () => {
        const generate = scripted();
        const before = jest.fn(async () => {
            throw Error('budget refused');
        });
        await expect(
            runAgentLoopCall({
                runName: 'test',
                messages: [{ role: 'user', content: 'data' }],
                loop: { tools: {}, maxSteps: 1, modelCallBudget: { before } },
            } as any),
        ).rejects.toThrow('budget refused');
        expect(generate).not.toHaveBeenCalled();
    });
});

it('budgets the same model again for tool repair and applies the repair output ceiling', async () => {
    const calls: any[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: async (options: any) => {
            calls.push(options);
            return {
                content:
                    calls.length === 1
                        ? [
                              {
                                  type: 'tool-call',
                                  toolCallId: 'broken',
                                  toolName: 'read_file',
                                  input: '{broken',
                              },
                          ]
                        : [{ type: 'text', text: '{"path":"src/a.ts"}' }],
                finishReason: {
                    unified: calls.length === 1 ? 'tool-calls' : 'stop',
                    raw: 'stop',
                },
                usage: {
                    inputTokens: {
                        total: calls.length * 10,
                        noCache: calls.length * 10,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                },
                warnings: [],
            };
        },
    } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: { maxOutputTokens: 1000 },
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    const finished: any[] = [];
    const before = jest.fn(async () => ({
        maxOutputTokens: 7,
        finish: (result: any) => {
            finished.push(result);
        },
    }));
    const { jsonSchema, tool } = await import('ai');
    await runAgentLoopCall({
        runName: 'repair-budget',
        messages: [{ role: 'user', content: 'read source' }],
        loop: {
            tools: {
                read_file: tool({
                    inputSchema: jsonSchema({
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    }),
                }),
            },
            maxSteps: 1,
            modelCallBudget: { before },
        },
    } as any);
    expect(before).toHaveBeenCalledTimes(2);
    expect(before.mock.calls[1][0]).toHaveProperty(
        'responseFormat.type',
        'json',
    );
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([7, 7]);
    expect(finished.map((r) => r.usage.inputTokens.total)).toEqual([10, 20]);
});

it('checks a fresh lease before an SDK retry and refuses before the second provider dispatch', async () => {
    const { APICallError } = await import('@ai-sdk/provider');
    const generate = jest.fn(async () => {
        throw new APICallError({
            message: 'transient fixture',
            url: 'https://model.test',
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
        });
    });
    const model = new MockLanguageModelV3({ doGenerate: generate } as any);
    (resolveModelConfig as jest.Mock).mockReturnValue({
        model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    });
    const finish = jest.fn();
    const before = jest
        .fn()
        .mockResolvedValueOnce({ maxOutputTokens: 7, finish })
        .mockRejectedValue(new Error('second attempt refused'));
    await expect(
        runAgentLoopCall({
            runName: 'retry-budget',
            messages: [{ role: 'user', content: 'data' }],
            loop: { tools: {}, maxSteps: 1, modelCallBudget: { before } },
        } as any),
    ).rejects.toThrow('second attempt refused');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledWith({ outcome: 'failed' });
});
