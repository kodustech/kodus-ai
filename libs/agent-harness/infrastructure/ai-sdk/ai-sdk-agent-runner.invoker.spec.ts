jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';
import type { AgentSpec } from '../../domain/contracts/agent.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const spec: AgentSpec = {
    id: 'runtime-test-planner',
    systemPrompt: 'Plan without deciding a verdict.',
    maxSteps: 12,
    tools: new InMemoryToolRegistry([]),
    policies: [],
};
const result = {
    steps: [],
    text: 'done',
    usage: { inputTokens: 0, outputTokens: 0 },
};

describe('optional agent loop invoker', () => {
    beforeEach(() =>
        (LLM.run as jest.Mock).mockReset().mockResolvedValue(result),
    );

    it('keeps LLM.run as the default with the existing assembled request', async () => {
        const out = await new AiSdkAgentRunner(undefined).run(
            spec,
            { prompt: 'check route' },
            { runId: 'run' },
        );
        expect(out.status).toBe('completed');
        expect(LLM.run).toHaveBeenCalledWith(
            expect.objectContaining({
                byokConfig: undefined,
                system: spec.systemPrompt,
                messages: [{ role: 'user', content: 'check route' }],
                loop: {
                    tools: {},
                    maxSteps: 12,
                    stopWhen: [expect.any(Function)],
                    prepareStep: expect.any(Function),
                    onStepFinish: expect.any(Function),
                },
            }),
        );
    });

    it('uses the injected invoker without calling LLM.run or requiring a BYOK slot', async () => {
        const invoke = jest.fn().mockResolvedValue(result);
        const signal = new AbortController().signal;
        const out = await new (AiSdkAgentRunner as any)(
            undefined,
            {},
            invoke,
        ).run(spec, { prompt: 'check route' }, { runId: 'run', signal });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke.mock.calls[0][0]).toMatchObject({
            byokConfig: undefined,
            signal,
        });
        expect(LLM.run).not.toHaveBeenCalled();
        expect(out).toMatchObject({
            status: 'completed',
            usage: { inputTokens: 0, outputTokens: 0 },
        });
    });

    it('does not fall back to the default model when the injected boundary fails', async () => {
        const invoke = jest
            .fn()
            .mockRejectedValue(new Error('turn unavailable'));
        const out = await new (AiSdkAgentRunner as any)(
            undefined,
            {},
            invoke,
        ).run(spec, { prompt: 'check route' }, { runId: 'run' });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(LLM.run).not.toHaveBeenCalled();
        expect(out.status).toBe('error');
    });
});
