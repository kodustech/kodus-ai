import { retryWithBackoff } from './retry-with-backoff';

// Tiny intervals + no jitter so the suite runs in ~milliseconds.
const FAST_BACKOFF = {
    baseInterval: 1,
    maxInterval: 8,
    multiplier: 2,
    jitterFactor: 0,
};

describe('retryWithBackoff', () => {
    it('returns the value without retrying when fn succeeds first try', async () => {
        const fn = jest.fn().mockResolvedValue('ok');

        const result = await retryWithBackoff(fn, {
            maxAttempts: 3,
            backoff: FAST_BACKOFF,
        });

        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and resolves once fn succeeds', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail 1'))
            .mockRejectedValueOnce(new Error('fail 2'))
            .mockResolvedValue('ok');
        const onRetry = jest.fn();

        const result = await retryWithBackoff(fn, {
            maxAttempts: 5,
            backoff: FAST_BACKOFF,
            onRetry,
        });

        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it('throws the last error once maxAttempts is exhausted', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail 1'))
            .mockRejectedValue(new Error('final failure'));

        await expect(
            retryWithBackoff(fn, { maxAttempts: 3, backoff: FAST_BACKOFF }),
        ).rejects.toThrow('final failure');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('fails fast without retrying when shouldRetry returns false', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('permanent'));
        const shouldRetry = jest.fn().mockReturnValue(false);

        await expect(
            retryWithBackoff(fn, {
                maxAttempts: 5,
                backoff: FAST_BACKOFF,
                shouldRetry,
            }),
        ).rejects.toThrow('permanent');
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
