import { z } from 'zod';

// Mock the model builders so no real model/network is touched. v2-only:
// `buildModelFromSlot` takes ONE resolved slot. The production call reads the
// carrier's `.main` slot at its boundary, so the fallback slot is never handed
// to the builder — tests assert the single `main` model is used everywhere and
// that a 2nd (fallback) slot is NEVER built.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(() => ({ __model: 'main' })),
    getModelName: jest.fn(() => 'test-model'),
    // Default: no limiter cached (slot not in cooldown). Cooldown tests override
    // this to return a stub limiter reporting isInCooldown()=true.
    getLimiterForSlot: jest.fn(() => null),
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
jest.mock('@libs/llm/reasoning-options', () => ({
    buildProviderOptions: jest.fn(() => ({ __providerOptions: 'reasoning' })),
}));

import {
    runStructuredReviewCall,
    runTextReviewCall,
} from '@libs/llm/structured-review-call';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import {
    buildModelFromSlot,
    getLimiterForSlot,
} from '@libs/llm/byok-to-vercel';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;
const mockBuild = buildModelFromSlot as unknown as jest.Mock;
const mockGetLimiter = getLimiterForSlot as unknown as jest.Mock;

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

/** No 2nd (fallback) model is ever built — the run resolves ONE model. The
 *  builder is only ever handed the resolved `main` slot, never a fallback slot. */
const assertNoSecondModelBuilt = () => {
    expect(mockBuild).not.toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' }),
        expect.anything(),
    );
    // Every generateText attempt ran the SAME (main) model — never a 2nd model.
    for (const model of modelsUsed()) {
        expect(model).toEqual({ __model: 'main' });
    }
};

beforeEach(() => {
    mockGenerate.mockReset();
    mockBuild.mockClear();
    mockGetLimiter.mockReset();
    mockGetLimiter.mockReturnValue(null); // default: slot not in cooldown
    observabilityService.runAiSdkLLMInSpan.mockClear();
    (buildProviderOptions as jest.Mock).mockClear();
});

describe('runTextReviewCall — plain-text half of the shared executor', () => {
    const textBase = {
        system: 'sys',
        user: 'usr',
        runName: 'summary.run',
        observabilityService,
    };

    it('returns the raw generated string and sends NO structured-output arg', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'a prose summary', usage: {} });

        const out = await runTextReviewCall({ ...textBase });

        expect(out).toBe('a prose summary');
        // Plain generateText: no `output` (Output.object) on the call.
        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty('output');
        // And the model is NOT built in structured-output mode.
        expect(mockBuild).toHaveBeenCalledWith(undefined, {}, undefined);
    });

    it('shares the reasoning path — honors the slot the same way', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });

        await runTextReviewCall({
            ...textBase,
            byokConfig: {
                provider: 'anthropic',
                apiKey: 'enc',
                model: 'claude-sonnet-4-5',
                reasoningEffort: 'medium',
            } as any,
        });

        expect(buildProviderOptions).toHaveBeenCalledWith(
            'summary.run',
            undefined,
            expect.objectContaining({ reasoningEffort: 'medium' }),
        );
        expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
            __providerOptions: 'reasoning',
        });
    });

    it('an empty response degrades to an empty string (never throws)', async () => {
        mockGenerate.mockResolvedValueOnce({ usage: {} }); // no .text
        await expect(runTextReviewCall({ ...textBase })).resolves.toBe('');
    });

    it('threads defaultModelOverride to the build (trial default, e.g. the PR summary)', async () => {
        mockGenerate.mockResolvedValueOnce({ text: 'x', usage: {} });
        await runTextReviewCall({
            ...textBase,
            defaultModelOverride: 'accounts/fireworks/models/deepseek-v4-flash',
        });
        expect(mockBuild).toHaveBeenCalledWith(
            undefined,
            {},
            'accounts/fireworks/models/deepseek-v4-flash',
        );
    });
});

describe('runStructuredReviewCall — reasoning (honors the slot, no added default)', () => {
    it("passes the slot's reasoning through the SHARED mapping into the call", async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: {
                provider: 'openai',
                apiKey: 'enc',
                model: 'gpt-5',
                reasoningEffort: 'high',
            } as any,
        });

        // The slot's effort reaches the provider mapping (the drop this fixes)...
        expect(buildProviderOptions).toHaveBeenCalledWith(
            'test.run',
            undefined,
            expect.objectContaining({
                reasoningEffort: 'high',
                byokProvider: 'openai',
                modelName: 'gpt-5',
            }),
        );
        // ...and its result is spread as providerOptions on the SDK call.
        expect(mockGenerate.mock.calls[0][0].providerOptions).toEqual({
            __providerOptions: 'reasoning',
        });
    });

    it('an unset slot reasoning still calls the mapping with undefined effort (→ none)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ ok: true }));
        await runStructuredReviewCall({ ...base }); // no byokConfig
        expect(buildProviderOptions).toHaveBeenCalledWith(
            'test.run',
            undefined,
            expect.objectContaining({ reasoningEffort: undefined }),
        );
    });
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

describe('runStructuredReviewCall — single retry owner (maxRetries:0 + cooldown-aware)', () => {
    it('pins maxRetries:0 on the SDK call so it is the ONLY retry layer', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({ ...base });

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ maxRetries: 0 }),
        );
    });

    it('maxRetries:0 is passed on BOTH the first attempt AND the D-00c re-issue', async () => {
        mockGenerate
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        await runStructuredReviewCall({ ...base });

        expect(mockGenerate).toHaveBeenCalledTimes(2);
        for (const call of mockGenerate.mock.calls) {
            expect(call[0]).toEqual(
                expect.objectContaining({ maxRetries: 0 }),
            );
        }
    });

    it('transient failure while the slot is IN COOLDOWN → NO re-issue, THROWS', async () => {
        // The wrapper armed the slot cooldown on the prior 429; the retry owner
        // must honor it — never re-fire into a cooling slot.
        mockGetLimiter.mockReturnValue({ isInCooldown: () => true });
        mockGenerate.mockRejectedValueOnce(new Error('fetch failed'));

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('fetch failed');

        // Exactly one attempt — the cooldown gate skipped the re-issue.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('RATE_LIMIT (429) failure → NO immediate re-fire, THROWS (backs off via cooldown)', async () => {
        // Slot in cooldown (arm-then-honor): a 429 never immediately re-issues.
        mockGetLimiter.mockReturnValue({ isInCooldown: () => true });
        const rateErr: any = new Error('rate limit exceeded');
        rateErr.status = 429;
        mockGenerate.mockRejectedValueOnce(rateErr);

        await expect(
            runStructuredReviewCall({
                ...base,
                byokConfig: { main: { provider: 'openai' } } as any,
            }),
        ).rejects.toThrow('rate limit');

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('RATE_LIMIT (429) with NO cooldown armed → still NO immediate re-fire, THROWS', async () => {
        // Even without a cooldown, a 429 is not hammered with an instant retry.
        mockGetLimiter.mockReturnValue(null);
        const rateErr: any = new Error('too many requests');
        rateErr.status = 429;
        mockGenerate.mockRejectedValueOnce(rateErr);

        await expect(runStructuredReviewCall({ ...base })).rejects.toThrow(
            'too many requests',
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        assertNoSecondModelBuilt();
    });

    it('transient failure NOT in cooldown → still exactly ONE same-model re-issue', async () => {
        mockGetLimiter.mockReturnValue({ isInCooldown: () => false });
        mockGenerate
            .mockRejectedValueOnce(new Error('socket hang up'))
            .mockResolvedValueOnce(ok({ violations: ['reissued'] }));

        const out = await runStructuredReviewCall({
            ...base,
            byokConfig: { main: { provider: 'openai' } } as any,
        });

        expect(out).toEqual({ violations: ['reissued'] });
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        assertNoSecondModelBuilt();
    });
});

describe('runStructuredReviewCall — per-model tuning (RFC §4.1 model limits)', () => {
    it('passes the resolved slot temperature + maxOutputTokens to the model call', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: {
                provider: 'openai',
                temperature: 0.3,
                maxOutputTokens: 5000,
            } as any,
        });

        expect(mockGenerate).toHaveBeenCalledWith(
            expect.objectContaining({ temperature: 0.3, maxOutputTokens: 5000 }),
        );
    });

    it('omits tuning when the slot does not set it (falls back to model defaults)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({ ...base }); // no slot at all

        const args = mockGenerate.mock.calls[0][0];
        expect(args).not.toHaveProperty('temperature');
        expect(args).not.toHaveProperty('maxOutputTokens');
    });

    it('treats a non-positive maxOutputTokens as "use the model default" (dropped)', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ violations: [] }));

        await runStructuredReviewCall({
            ...base,
            byokConfig: { provider: 'openai', maxOutputTokens: 0 } as any,
        });

        expect(mockGenerate.mock.calls[0][0]).not.toHaveProperty(
            'maxOutputTokens',
        );
    });
});
