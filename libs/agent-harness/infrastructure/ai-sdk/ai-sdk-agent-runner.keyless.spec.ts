import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';

it('loads and runs an injected SDK loop without importing the product model/credential layer', async () => {
    let productLayerLoads = 0;
    await jest.isolateModulesAsync(async () => {
        jest.doMock('@libs/llm/llm', () => {
            productLayerLoads++;
            throw new Error(
                'Product model/credential layer must not load for an injected invoker',
            );
        });
        const { AiSdkAgentRunner } = await import('./ai-sdk-agent-runner');
        const invoke = jest.fn(async () => ({
            steps: [],
            text: 'done',
            usage: { inputTokens: 0, outputTokens: 0 },
        }));
        const runner = new AiSdkAgentRunner(undefined, {}, invoke as any);
        const result = await runner.run(
            {
                id: 'keyless-planner',
                systemPrompt: 'Plan without a local model.',
                tools: new InMemoryToolRegistry([]),
                policies: [],
                maxSteps: 1,
            },
            { prompt: 'check route' },
            { runId: 'fixture-run' },
        );
        expect(result.status).toBe('completed');
        expect(invoke).toHaveBeenCalledTimes(1);
    });
    expect(productLayerLoads).toBe(0);
});
