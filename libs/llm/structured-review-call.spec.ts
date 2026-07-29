import { z } from 'zod';

// Mock the model builders so no real model/network is touched. `byokToVercelModel`
// returns a sentinel tagged with the role so tests can assert WHICH model an
// attempt used — and, crucially, that a 2nd ('fallback') model is NEVER built.
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

import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { byokToVercelModel } from '@libs/llm/byok-to-vercel';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;
const mockByokToVercel = byokToVercelModel as unknown as jest.Mock;

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

const modelsUsed = () => mockGenerate.mock.calls.map((c) => c[0].model);

/** No 2nd ('fallback') model is ever built — the run resolves ONE model. */
const assertNoSecondModelBuilt = () => {
    expect(mockByokToVercel).not.toHaveBeenCalledWith(
        expect.anything(),
        'fallback',
        expect.anything(),
    );
    // Every generateText attempt ran the SAME (main) model — never a 2nd model.
    for (const model of modelsUsed()) {
        expect(model).toEqual({ __model: 'main' });
    }
};

beforeEach(() => {
    mockGenerate.mockReset();
    mockByokToVercel.mockClear();
    observabilityService.runAiSdkLLMInSpan.mockClear();
});

describe('runStructuredReviewCall — single-model policy (no runtime fallback)', () => {
    it('trial (no BYOK): runs the ONE resolved model and returns its output', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(modelsUsed()).toEqual([{ __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('trial (no BYOK): a non-transient main failure THROWS — no 2nd model', async () => {
        const authErr: any = new Error('invalid api key');
        authErr.status = 401;
        mockGenerate.mockRejectedValueOnce(authErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'invalid api key',
        );

        // Exactly one attempt — no Groq, no byok-fallback, no re-issue.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('BYOK: a main failure THROWS and never cascades to a 2nd model', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('byok main down'));

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: {
                    main: { provider: 'openai' },
                    // Even with a legacy `fallback` blob present, v2-only means
                    // no runtime cascade — the 2nd model is never built or run.
                    fallback: { provider: 'anthropic' },
                } as any,
            }),
        ).rejects.toThrow('byok main down');

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });
});

describe('runStructuredReviewCall — retained latency guard (D-00c: one gated SAME-model re-issue)', () => {
    it('transient main failure → exactly ONE SAME-model re-issue, returns its output', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        const out = await runStructuredReviewCall({ ...base });

        expect(out).toEqual({ violations: ['reissued'] });
        // main fails → ONE same-model re-issue succeeds. Both attempts are `main`.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()).toEqual([{ __model: 'main' }, { __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('transient failure twice → single re-issue then THROWS (re-issue capped at one, no 2nd model)', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockRejectedValueOnce(new Error('socket hang up again'));

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'socket hang up again',
        );

        // main + exactly one same-model re-issue = 2 attempts, then propagate.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(modelsUsed()).toEqual([{ __model: 'main' }, { __model: 'main' }]);
        assertNoSecondModelBuilt();
    });

    it('AbortError → NO re-issue, THROWS (re-issuing a slow call just times out again)', async () => {
        const abortErr: any = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        mockGenerate.mockRejectedValueOnce(abortErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'The operation was aborted',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('[HARD-TIMEOUT] error → NO re-issue, THROWS', async () => {
        mockGenerate.mockRejectedValueOnce(
            new Error('[HARD-TIMEOUT] exceeded 600000ms'),
        );

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            '[HARD-TIMEOUT]',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('non-transient main failure (401 auth) → NO re-issue, THROWS', async () => {
        const authErr: any = new Error('invalid api key');
        authErr.status = 401;
        mockGenerate.mockRejectedValueOnce(authErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'invalid api key',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });
});
