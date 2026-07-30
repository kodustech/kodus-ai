import {
    runWithProviderFallback,
    providerErrorFromResult,
    type ProviderFallbackOptions,
} from './model-fallback';
import type { AgentModelParams } from './model-factory';

const main: AgentModelParams = {
    role: 'main',
    model: {} as any,
    modelName: 'openai:gpt-main',
};
const fallback: AgentModelParams = {
    role: 'fallback',
    model: {} as any,
    modelName: 'anthropic:claude-fallback',
};

function run<T>(opts: Partial<ProviderFallbackOptions<T>> & Pick<ProviderFallbackOptions<T>, 'attempt'>) {
    return runWithProviderFallback({ main, fallback, ...opts });
}

describe('runWithProviderFallback', () => {
    it('returns the main result without touching fallback when main succeeds', async () => {
        const attempt = jest.fn(async (p: AgentModelParams) => p.modelName);

        const result = await run({ attempt });

        expect(result).toBe('openai:gpt-main');
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(attempt.mock.calls[0][0].role).toBe('main');
    });

    it('retries with the fallback model when main throws, and completes', async () => {
        const onFallback = jest.fn();
        const attempt = jest.fn(async (p: AgentModelParams) => {
            if (p.role === 'main') {
                throw new Error('AI_APICallError: Not found the model');
            }
            return p.modelName;
        });

        const result = await run({ attempt, onFallback });

        expect(result).toBe('anthropic:claude-fallback');
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(attempt.mock.calls[1][0].role).toBe('fallback');
        expect(onFallback).toHaveBeenCalledTimes(1);
    });

    it('falls back when main returns a non-throwing failure result (harness-swallowed error)', async () => {
        const onFallback = jest.fn();
        const attempt = jest.fn(async (p: AgentModelParams) =>
            p.role === 'main'
                ? { finishReason: 'error', suggestions: [] }
                : { finishReason: 'stop', suggestions: ['bug'] },
        );

        const result = await runWithProviderFallback({
            main,
            fallback,
            attempt,
            isFailure: (r: any) => r?.finishReason === 'error',
            onFallback,
        });

        expect(result).toEqual({ finishReason: 'stop', suggestions: ['bug'] });
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(attempt.mock.calls[1][0].role).toBe('fallback');
        expect(onFallback).toHaveBeenCalledTimes(1);
    });

    it('does NOT fall back on a non-failure result (legit empty / timeout)', async () => {
        const attempt = jest.fn(async () => ({ finishReason: 'timeout' }));

        const result = await runWithProviderFallback({
            main,
            fallback,
            attempt,
            isFailure: (r: any) => r?.finishReason === 'error',
        });

        expect(result).toEqual({ finishReason: 'timeout' });
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('propagates the fallback error when the fallback also fails', async () => {
        const attempt = jest.fn(async (p: AgentModelParams) => {
            throw new Error(`${p.role} down`);
        });

        await expect(run({ attempt })).rejects.toThrow('fallback down');
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('rethrows the main error and does not retry when no fallback is configured', async () => {
        const attempt = jest.fn(async () => {
            throw new Error('main down');
        });

        await expect(
            runWithProviderFallback({ main, fallback: null, attempt }),
        ).rejects.toThrow('main down');
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('still runs the fallback when the onFallback hook throws', async () => {
        const attempt = jest.fn(async (p: AgentModelParams) => {
            if (p.role === 'main') throw new Error('main down');
            return p.modelName;
        });
        const onFallback = jest.fn(() => {
            throw new Error('telemetry hook exploded');
        });

        const result = await run({ attempt, onFallback });

        expect(result).toBe('anthropic:claude-fallback');
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(onFallback).toHaveBeenCalledTimes(1);
    });

    it('rethrows without falling back when shouldFallback vetoes (e.g. job cancelled)', async () => {
        const onFallback = jest.fn();
        const attempt = jest.fn(async () => {
            throw new Error('aborted');
        });

        await expect(
            run({ attempt, shouldFallback: () => false, onFallback }),
        ).rejects.toThrow('aborted');
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(onFallback).not.toHaveBeenCalled();
    });
});

describe('providerErrorFromResult', () => {
    it('returns null for a healthy result', () => {
        expect(
            providerErrorFromResult({ finishReason: 'stop' }),
        ).toBeNull();
    });

    it('returns null for a non-error stop (timeout/budget)', () => {
        expect(
            providerErrorFromResult({ finishReason: 'timeout' }),
        ).toBeNull();
        expect(providerErrorFromResult(undefined)).toBeNull();
    });

    it('reconstructs a classifiable error carrying the provider message/name', () => {
        const err = providerErrorFromResult({
            finishReason: 'error',
            errorMessage: 'Not found the model kimi-x or Permission denied',
            errorName: 'AI_APICallError',
        });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain('Not found the model kimi-x');
        expect(err!.name).toBe('AI_APICallError');
    });

    it('falls back to a generic message when none is present', () => {
        const err = providerErrorFromResult({ finishReason: 'error' });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(/provider call returned an error/i);
    });
});
