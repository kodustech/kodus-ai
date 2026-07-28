import { z } from 'zod';

// Mock the model builders so no real model/network is touched. Each returns a
// sentinel tagged with the role/provider so tests can assert WHICH model a
// given attempt used.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn((_byokConfig: any, role: string) => ({
        __model: role,
    })),
    getModelName: jest.fn(() => 'test-model'),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({
        telemetry: { isEnabled: false },
    })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const base = {
    schema: z.any(),
    system: 'sys',
    user: 'usr',
    runName: 'test.run',
    observabilityService,
};

describe('runStructuredReviewCall — model & fallback policy', () => {
    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    const modelsUsed = () =>
        mockGenerate.mock.calls.map((c) => c[0].model);

    it('trial (no BYOK): runs the main model, no fallback when it succeeds', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(modelsUsed()).toEqual([{ __model: 'main' }]);
    });

    it('trial (no BYOK): falls back to Groq gpt-oss-120b when main fails', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('main down'))
            .mockResolvedValueOnce(ok({ violations: ['x'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['x'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()[1]).toMatchObject({
            __model: 'groq',
            modelId: 'openai/gpt-oss-120b',
        });
    });

    it('BYOK without fallback: main failure throws, never cascades to our Groq', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('byok main down'));

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('byok main down');

        // Only the main attempt — no managed Groq fallback for a BYOK org.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it("BYOK with fallback: main failure uses the customer's own fallback", async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('byok main down'))
            .mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({
            ...base,
            byokConfig: {
                main: { provider: 'openai' },
                fallback: { provider: 'anthropic' },
            } as any,
        });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        // Second attempt is the customer's fallback role, NOT the Groq sentinel.
        expect(modelsUsed()[1]).toEqual({ __model: 'fallback' });
    });
});

describe('runStructuredReviewCall — minimal latency guard (D-00c: one gated re-issue)', () => {
    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    const modelsUsed = () => mockGenerate.mock.calls.map((c) => c[0].model);

    it('transient main failure → exactly ONE same-model re-issue, returns its output before any fallback', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['reissued'] });
        // main fails → one same-model re-issue succeeds; the Groq fallback is never touched.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()).toEqual([{ __model: 'main' }, { __model: 'main' }]);
    });

    it('AbortError → NO re-issue, straight to fallback (re-issuing a slow call just times out again)', async () => {
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        mockGenerate
            .mockRejectedValueOnce(abortErr)
            .mockResolvedValueOnce(ok({ violations: ['fallback'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['fallback'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        // Second call is the Groq fallback — NOT a same-model re-issue.
        expect(modelsUsed()[1]).toMatchObject({
            __model: 'groq',
            modelId: 'openai/gpt-oss-120b',
        });
    });

    it('[HARD-TIMEOUT] error → NO re-issue, straight to fallback', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('[HARD-TIMEOUT] exceeded 600000ms'))
            .mockResolvedValueOnce(ok({ violations: ['fallback'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['fallback'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()[1]).toMatchObject({
            __model: 'groq',
            modelId: 'openai/gpt-oss-120b',
        });
    });

    it('BYOK no-fallback + [HARD-TIMEOUT] → throws without re-issue (single attempt)', async () => {
        mockGenerate.mockRejectedValueOnce(
            new Error('[HARD-TIMEOUT] exceeded 600000ms'),
        );

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('[HARD-TIMEOUT]');

        // No re-issue and no managed Groq cascade for a BYOK org — exactly one attempt.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('non-transient main failure (401 auth) → NO re-issue, straight to fallback', async () => {
        const authErr: any = new Error('invalid api key');
        authErr.status = 401;
        mockGenerate
            .mockRejectedValueOnce(authErr)
            .mockResolvedValueOnce(ok({ violations: ['fallback'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['fallback'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()[1]).toMatchObject({
            __model: 'groq',
            modelId: 'openai/gpt-oss-120b',
        });
    });

    it('re-issue is capped at ONE: transient twice → single re-issue, then fallback (no retry loop)', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockResolvedValueOnce(ok({ violations: ['fallback'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['fallback'] });
        // main + exactly one re-issue + fallback = 3 attempts total.
        expect(mockGenerate).toHaveBeenCalledTimes(3);
        expect(modelsUsed()).toEqual([
            { __model: 'main' },
            { __model: 'main' },
            { __model: 'groq', modelId: 'openai/gpt-oss-120b' },
        ]);
    });
});
