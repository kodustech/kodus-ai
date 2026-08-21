/**
 * model-failover.spec.ts — the runtime primary→fallback cascade primitive.
 *
 * The error classifier is MOCKED so these tests pin the primitive's OWN logic
 * (which category cascades, the loop, the unsafe-to-retry veto) independent of
 * the status→category mapping, which `error-classifier.spec.ts` owns. Categories
 * are carried on the thrown error as `__cat` and abort as `__abort`.
 */
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

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
    };
});

import {
    runWithModelFailover,
    shouldFailoverToNextModel,
    type FailoverAttemptControl,
} from './model-failover';
import type { NormalizedModel } from './byok-config';

const err = (cat: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`boom:${cat}`), { __cat: cat, ...extra });

const slot = (id: string): NormalizedModel =>
    ({ model: id, byokModelId: id, provider: 'openai', apiKey: 'enc' } as any);

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
            ({ model: m, provider: 'openai', apiKey: 'enc' } as any);
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
});
