/**
 * model-failover.spec.ts — the runtime primary→fallback cascade primitive.
 *
 * The error classifier is MOCKED so these tests pin the primitive's OWN logic
 * (which category cascades, the loop, the unsafe-to-retry veto) independent of
 * the status→category mapping, which `error-classifier.spec.ts` owns. Categories
 * are carried on the thrown error as `__cat` and abort as `__abort`.
 */
// One stable spy per module load (the factory closes over it and `createLogger`
// always returns it) so tests can assert the [LLM-ERROR]/[LLM-SUCCESS]
// observability lines this primitive emits. Fetched below via `createLogger`
// rather than an outer const — ESM import hoisting would load model-failover
// (and its module-level createLogger call) before an outer const initialized.
jest.mock('@libs/core/log/logger', () => {
    const log = {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    return { createLogger: () => log };
});

jest.mock('@libs/llm/error-classifier', () => {
    const LlmErrorCategory = {
        AUTH_INVALID: 'AUTH_INVALID',
        QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
        RATE_LIMIT: 'RATE_LIMIT',
        MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
        MODEL_ACCESS_DENIED: 'MODEL_ACCESS_DENIED',
        CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
        TRANSIENT: 'TRANSIENT',
        UNKNOWN: 'UNKNOWN',
    };
    const TERMINAL = new Set([
        'AUTH_INVALID',
        'QUOTA_EXCEEDED',
        'MODEL_NOT_FOUND',
        'MODEL_ACCESS_DENIED',
    ]);
    return {
        LlmErrorCategory,
        classifyLLMError: (e: any) => ({ category: e?.__cat ?? 'UNKNOWN' }),
        isTerminalCategory: (c: string) => TERMINAL.has(c),
        isAbortOrHardTimeout: (e: any) => e?.__abort === true,
        retriesWereExhausted: (e: any) => e?.__exhausted === true,
    };
});

import {
    readAttemptedSlot,
    runWithModelFailover,
    shouldFailoverToNextModel,
    type FailoverAttemptControl,
} from './model-failover';
import type { NormalizedModel } from './byok-config';
import { createLogger } from '@libs/core/log/logger';

// The mocked createLogger always returns the same spy instance model-failover
// captured at module load, so this is that exact instance.
const mockLog = createLogger('test') as unknown as {
    warn: jest.Mock;
    info: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
};

const err = (cat: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`boom:${cat}`), { __cat: cat, ...extra });

const slot = (id: string): NormalizedModel =>
    ({ model: id, byokModelId: id, provider: 'openai', apiKey: 'enc' }) as any;

describe('shouldFailoverToNextModel', () => {
    it('cascades on terminal model-specific failures', () => {
        for (const cat of [
            'AUTH_INVALID',
            'QUOTA_EXCEEDED',
            'MODEL_NOT_FOUND',
            'MODEL_ACCESS_DENIED',
        ]) {
            expect(shouldFailoverToNextModel(err(cat))).toBe(true);
        }
    });

    it('cascades on a persistent transient blip', () => {
        expect(shouldFailoverToNextModel(err('TRANSIENT'))).toBe(true);
    });

    it('does NOT cascade on rate-limit, context-overflow, or unknown', () => {
        expect(shouldFailoverToNextModel(err('RATE_LIMIT'))).toBe(false);
        expect(shouldFailoverToNextModel(err('CONTEXT_OVERFLOW'))).toBe(false);
        expect(shouldFailoverToNextModel(err('UNKNOWN'))).toBe(false);
    });

    it('DOES cascade on a rate-limit that outlived its same-model retries', () => {
        // The limiter owns a 429 it can still wait out; it does not own one that
        // already survived exponential backoff. See retriesWereExhausted.
        expect(
            shouldFailoverToNextModel(err('RATE_LIMIT', { __exhausted: true })),
        ).toBe(true);
    });

    it('keeps context-overflow and unknown refused even when exhausted', () => {
        // Exhaustion says the failure is PERSISTENT, not that a peer model can
        // fix it: the prompt is still too big, and unknown is still unknown.
        expect(
            shouldFailoverToNextModel(
                err('CONTEXT_OVERFLOW', { __exhausted: true }),
            ),
        ).toBe(false);
        expect(
            shouldFailoverToNextModel(err('UNKNOWN', { __exhausted: true })),
        ).toBe(false);
    });

    it('does NOT cascade on abort / hard-timeout even if otherwise transient', () => {
        expect(
            shouldFailoverToNextModel(err('TRANSIENT', { __abort: true })),
        ).toBe(false);
    });
});

describe('runWithModelFailover', () => {
    const opts = { runName: 'test' };

    it('runs the primary once and returns it on success (fallback untouched)', async () => {
        const runOne = jest.fn().mockResolvedValue('ok');
        const out = await runWithModelFailover(
            [slot('A'), slot('B')],
            runOne,
            opts,
        );
        expect(out).toBe('ok');
        expect(runOne).toHaveBeenCalledTimes(1);
        expect(runOne.mock.calls[0][0]).toMatchObject({ model: 'A' });
    });

    it('cascades to the fallback on a terminal failure and returns it', async () => {
        const runOne = jest
            .fn()
            .mockRejectedValueOnce(err('AUTH_INVALID'))
            .mockResolvedValueOnce('from-fallback');
        const out = await runWithModelFailover(
            [slot('A'), slot('B')],
            runOne,
            opts,
        );
        expect(out).toBe('from-fallback');
        expect(runOne).toHaveBeenCalledTimes(2);
        expect(runOne.mock.calls[1][0]).toMatchObject({ model: 'B' });
    });

    it('does NOT cascade on a non-cascade-worthy error (rate-limit)', async () => {
        const runOne = jest.fn().mockRejectedValue(err('RATE_LIMIT'));
        await expect(
            runWithModelFailover([slot('A'), slot('B')], runOne, opts),
        ).rejects.toThrow('boom:RATE_LIMIT');
        expect(runOne).toHaveBeenCalledTimes(1);
    });

    it('does NOT cascade when the attempt marked itself unsafe to retry', async () => {
        const runOne = jest.fn(
            async (_s: unknown, c: FailoverAttemptControl) => {
                c.markUnsafeToRetry();
                throw err('AUTH_INVALID');
            },
        );
        await expect(
            runWithModelFailover([slot('A'), slot('B')], runOne, opts),
        ).rejects.toThrow('boom:AUTH_INVALID');
        expect(runOne).toHaveBeenCalledTimes(1);
    });

    it('re-throws the LAST error when both the primary and fallback fail', async () => {
        const runOne = jest
            .fn()
            .mockRejectedValueOnce(err('TRANSIENT'))
            .mockRejectedValueOnce(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([slot('A'), slot('B')], runOne, opts),
        ).rejects.toThrow('boom:AUTH_INVALID');
        expect(runOne).toHaveBeenCalledTimes(2);
    });

    it('is a pass-through with a single slot (no fallback to cascade to)', async () => {
        const runOne = jest.fn().mockRejectedValue(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([slot('A')], runOne, opts),
        ).rejects.toThrow('boom:AUTH_INVALID');
        expect(runOne).toHaveBeenCalledTimes(1);
    });

    it('dedupes a fallback identical to the primary (one attempt)', async () => {
        const runOne = jest.fn().mockRejectedValue(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([slot('A'), slot('A')], runOne, opts),
        ).rejects.toThrow();
        expect(runOne).toHaveBeenCalledTimes(1);
    });

    it('dedupes by model name when a slot has no byokModelId', async () => {
        const named = (m: string): NormalizedModel =>
            ({ model: m, provider: 'openai', apiKey: 'enc' }) as any;
        const runOne = jest.fn().mockRejectedValue(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([named('X'), named('X')], runOne, opts),
        ).rejects.toThrow();
        expect(runOne).toHaveBeenCalledTimes(1);
    });

    it('runs the managed-default (undefined) attempt exactly once', async () => {
        const runOne = jest.fn().mockResolvedValue('managed');
        const out = await runWithModelFailover([undefined], runOne, opts);
        expect(out).toBe('managed');
        expect(runOne).toHaveBeenCalledTimes(1);
        expect(runOne.mock.calls[0][0]).toBeUndefined();
    });

    it('drops an `undefined` that trails a real slot (never queued as a fallback)', async () => {
        // distinctAttempts pushes the managed-default (undefined) ONLY as the sole
        // entry — an undefined AFTER a real slot must be dropped, so a terminal
        // primary failure does NOT cascade into a bogus managed-default attempt.
        const runOne = jest.fn().mockRejectedValue(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([slot('A'), undefined], runOne, opts),
        ).rejects.toThrow();
        expect(runOne).toHaveBeenCalledTimes(1);
        expect(runOne.mock.calls[0][0]).toMatchObject({ model: 'A' });
    });
});

describe('runWithModelFailover — observability ([LLM-ERROR]/[LLM-SUCCESS])', () => {
    const opts = { runName: 'test', organizationId: 'org-1' };
    beforeEach(() => {
        mockLog.warn.mockClear();
        mockLog.debug.mockClear();
    });

    it('emits a [LLM-SUCCESS] debug line with the model and usedFallback=false on a primary win', async () => {
        const runOne = jest.fn().mockResolvedValue('ok');
        await runWithModelFailover([slot('A'), slot('B')], runOne, opts);
        expect(mockLog.debug).toHaveBeenCalledTimes(1);
        const call = mockLog.debug.mock.calls[0][0];
        expect(call.message).toContain('[LLM-SUCCESS]');
        expect(call.message).toContain('A');
        expect(call.metadata.usedFallback).toBe(false);
    });

    it('stamps usedFallback=true on the success line when the fallback saved the call', async () => {
        const runOne = jest
            .fn()
            .mockRejectedValueOnce(err('AUTH_INVALID'))
            .mockResolvedValueOnce('ok');
        await runWithModelFailover([slot('A'), slot('B')], runOne, opts);
        const success = mockLog.debug.mock.calls[0][0];
        expect(success.message).toContain('[LLM-SUCCESS]');
        expect(success.metadata.usedFallback).toBe(true);
    });

    it('names from→to (the i+1 fallback) on the cascade [LLM-ERROR] warn', async () => {
        const runOne = jest
            .fn()
            .mockRejectedValueOnce(err('AUTH_INVALID'))
            .mockResolvedValueOnce('ok');
        await runWithModelFailover([slot('A'), slot('B')], runOne, opts);
        const cascade = mockLog.warn.mock.calls[0][0];
        expect(cascade.message).toContain('[LLM-ERROR]');
        expect(cascade.message).toContain('A'); // from
        expect(cascade.message).toContain('B'); // to (attempts[i+1])
        expect(cascade.metadata.toModelId).toBe('B');
    });

    it('emits a terminal [LLM-ERROR] warn with the category and exhausted=true when all attempts fail', async () => {
        const runOne = jest.fn().mockRejectedValue(err('AUTH_INVALID'));
        await expect(
            runWithModelFailover([slot('A')], runOne, opts),
        ).rejects.toThrow();
        const terminal = mockLog.warn.mock.calls[0][0];
        expect(terminal.message).toContain('[LLM-ERROR]');
        expect(terminal.metadata.category).toBe('AUTH_INVALID');
        expect(terminal.metadata.exhausted).toBe(true);
    });
});

describe('the failed attempt is recorded ON the error', () => {
    const opts = { runName: 'test' };
    const providerSlot = (model: string, provider: string): NormalizedModel =>
        ({ model, byokModelId: model, provider, apiKey: 'enc' }) as any;

    it('names the FALLBACK when the fallback is what failed', async () => {
        // The whole point. Downstream reporting otherwise re-reads the slot
        // resolved before the run and names the primary — a model that did not
        // produce this failure, asserted as fact, in exactly the case a reader
        // needs the truth: both routes down.
        const runOne = jest
            .fn()
            .mockRejectedValueOnce(err('AUTH_INVALID'))
            .mockRejectedValueOnce(err('AUTH_INVALID'));

        await expect(
            runWithModelFailover(
                [
                    providerSlot('primary-model', 'openai'),
                    providerSlot('fallback-model', 'open_router'),
                ],
                runOne,
                opts,
            ),
        ).rejects.toMatchObject({ __cat: 'AUTH_INVALID' });

        const thrown = await runWithModelFailover(
            [
                providerSlot('primary-model', 'openai'),
                providerSlot('fallback-model', 'open_router'),
            ],
            jest
                .fn()
                .mockRejectedValueOnce(err('AUTH_INVALID'))
                .mockRejectedValueOnce(err('AUTH_INVALID')),
            opts,
        ).catch((e) => e);

        // Model AND provider come from the same attempt: a fallback model
        // reported beside the primary's provider is a pair that never existed.
        expect(readAttemptedSlot(thrown)).toEqual({
            model: 'fallback-model',
            provider: 'open_router',
        });
    });

    it('names the primary when there was no fallback to try', async () => {
        const thrown = await runWithModelFailover(
            [providerSlot('only-model', 'anthropic')],
            jest.fn().mockRejectedValue(err('AUTH_INVALID')),
            opts,
        ).catch((e) => e);

        expect(readAttemptedSlot(thrown)).toEqual({
            model: 'only-model',
            provider: 'anthropic',
        });
    });

    it('names the primary when the error must not cascade', async () => {
        // An unsafe-to-retry veto stops on the primary, so the primary is what
        // ran and what should be reported.
        const thrown = await runWithModelFailover(
            [
                providerSlot('primary-model', 'openai'),
                providerSlot('fallback-model', 'open_router'),
            ],
            async (_slot, control: FailoverAttemptControl) => {
                control.markUnsafeToRetry();
                throw err('AUTH_INVALID');
            },
            opts,
        ).catch((e) => e);

        expect(readAttemptedSlot(thrown)).toMatchObject({
            model: 'primary-model',
        });
    });

    it('stays invisible to JSON and span recording', async () => {
        // Non-enumerable, like the classification stamp — a diagnostic aid must
        // not turn into payload on every error that crosses a boundary.
        const thrown = await runWithModelFailover(
            [providerSlot('only-model', 'anthropic')],
            jest.fn().mockRejectedValue(err('AUTH_INVALID')),
            opts,
        ).catch((e) => e);

        expect(Object.keys(thrown)).not.toContain('attemptedSlot');
        expect(JSON.stringify(thrown)).not.toContain('only-model');
    });

    it('says nothing for an error that never went through the failover', () => {
        expect(readAttemptedSlot(new Error('unrelated'))).toBeUndefined();
        expect(readAttemptedSlot(undefined)).toBeUndefined();
        expect(readAttemptedSlot('a string')).toBeUndefined();
    });
});
