/**
 * llm.spec.ts — the `LLM.run` WIRING of runtime model failover (the seam between
 * a slot's `.fallback` and the executor cascade). The executors, the classifier
 * and the logger are mocked so these tests pin only what `run` is responsible for:
 *   - build the attempts `[slot, slot.fallback]` and inject each as `byokConfig`;
 *   - cascade one-shot calls to the fallback on a cascade-worthy failure;
 *   - guard the agent loop so a step that already ran vetoes the cascade.
 * The cascade decision itself lives in `model-failover.spec.ts`.
 */
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

// Control the cascade decision by category carried on the error (`__cascade`).
jest.mock('@libs/llm/error-classifier', () => ({
    LlmErrorCategory: { TRANSIENT: 'TRANSIENT', UNKNOWN: 'UNKNOWN' },
    classifyLLMError: (e: any) => ({ category: e?.__cat ?? 'UNKNOWN' }),
    isTerminalCategory: (c: string) => c === 'AUTH_INVALID',
    isAbortOrHardTimeout: () => false,
}));

const runStructuredReviewCall = jest.fn();
const runTextReviewCall = jest.fn();
const runAgentLoopCall = jest.fn();
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: (p: unknown) => runStructuredReviewCall(p),
    runTextReviewCall: (p: unknown) => runTextReviewCall(p),
}));
jest.mock('@libs/llm/agent-loop-call', () => ({
    runAgentLoopCall: (p: unknown) => runAgentLoopCall(p),
}));

import { LLM } from './llm';
import type { NormalizedModel } from './byok-config';

const authErr = () => Object.assign(new Error('unauth'), { __cat: 'AUTH_INVALID' });

const slotWithFallback: NormalizedModel = {
    model: 'primary',
    byokModelId: 'p',
    provider: 'openai',
    apiKey: 'enc',
    fallback: {
        model: 'fallback',
        byokModelId: 'f',
        provider: 'openai',
        apiKey: 'enc',
    },
} as any;

beforeEach(() => {
    runStructuredReviewCall.mockReset();
    runTextReviewCall.mockReset();
    runAgentLoopCall.mockReset();
});

describe('LLM.run — one-shot failover wiring', () => {
    it('cascades to slot.fallback on a cascade-worthy failure', async () => {
        runTextReviewCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce('from-fallback');

        const out = await LLM.run({
            byokConfig: slotWithFallback,
            user: 'hi',
            runName: 'r',
        });

        expect(out).toBe('from-fallback');
        expect(runTextReviewCall).toHaveBeenCalledTimes(2);
        // primary then fallback, each injected as byokConfig
        expect(runTextReviewCall.mock.calls[0][0].byokConfig.model).toBe('primary');
        expect(runTextReviewCall.mock.calls[1][0].byokConfig.model).toBe('fallback');
    });

    it('does not cascade when there is no fallback on the slot', async () => {
        runTextReviewCall.mockRejectedValue(authErr());
        const bare: NormalizedModel = {
            model: 'solo',
            byokModelId: 's',
            provider: 'openai',
            apiKey: 'enc',
        } as any;

        await expect(
            LLM.run({ byokConfig: bare, user: 'hi', runName: 'r' }),
        ).rejects.toThrow('unauth');
        expect(runTextReviewCall).toHaveBeenCalledTimes(1);
    });

    it('routes a structured call through the same cascade', async () => {
        runStructuredReviewCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce({ ok: true });

        const out = await LLM.run({
            byokConfig: slotWithFallback,
            user: 'hi',
            runName: 'r',
            schema: { parse: (v: unknown) => v } as any,
        });

        expect(out).toEqual({ ok: true });
        expect(runStructuredReviewCall).toHaveBeenCalledTimes(2);
    });
});

describe('LLM.run — agent-loop failover guard', () => {
    const loopReq = {
        byokConfig: slotWithFallback,
        runName: 'r',
        messages: [],
        loop: { tools: {}, maxSteps: 5 },
    };

    it('cascades when the loop fails BEFORE any step (clean restart)', async () => {
        runAgentLoopCall
            .mockRejectedValueOnce(authErr())
            .mockResolvedValueOnce('loop-fallback');

        const out = await LLM.run(loopReq as any);

        expect(out).toBe('loop-fallback');
        expect(runAgentLoopCall).toHaveBeenCalledTimes(2);
    });

    it('does NOT cascade once a step has emitted (unsafe to restart)', async () => {
        // Simulate a step running (fires onStepFinish) before the failure — the
        // guard must veto the cascade so runner state is not double-counted.
        runAgentLoopCall.mockImplementationOnce((params: any) => {
            params.loop.onStepFinish?.({ step: 1 });
            return Promise.reject(authErr());
        });

        await expect(LLM.run(loopReq as any)).rejects.toThrow('unauth');
        expect(runAgentLoopCall).toHaveBeenCalledTimes(1);
    });
});
