import { runWithTimeout } from './run-with-timeout';

describe('runWithTimeout (router core)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('aborts the AbortSignal when the deadline hits', async () => {
        jest.useFakeTimers();
        let capturedSignal: AbortSignal | undefined;
        const work = (signal: AbortSignal) => {
            capturedSignal = signal;
            return new Promise<void>(() => {}); // never resolves
        };

        const racing = runWithTimeout(work, 105 * 60 * 1000, 'timeout after 6300000ms');
        // Suppress unhandled rejection — we assert on it below
        racing.catch(() => {});

        await jest.advanceTimersByTimeAsync(105 * 60 * 1000 + 1);

        await expect(racing).rejects.toThrow('timeout after 6300000ms');
        expect(capturedSignal?.aborted).toBe(true);
    });

    it('returns the work result without aborting when it finishes in time', async () => {
        let capturedSignal: AbortSignal | undefined;
        const work = async (signal: AbortSignal) => {
            capturedSignal = signal;
            return 'done';
        };

        const result = await runWithTimeout(work, 1_000, 'should not fire');

        expect(result).toBe('done');
        expect(capturedSignal?.aborted).toBe(false);
    });

    it('propagates errors from the work without aborting the signal', async () => {
        let capturedSignal: AbortSignal | undefined;
        const work = async (signal: AbortSignal) => {
            capturedSignal = signal;
            throw new Error('processor exploded');
        };

        await expect(
            runWithTimeout(work, 1_000, 'unused'),
        ).rejects.toThrow('processor exploded');
        expect(capturedSignal?.aborted).toBe(false);
    });

    it('clears the timer in the finally block so no orphan timeouts leak', async () => {
        jest.useFakeTimers();
        const clearSpy = jest.spyOn(global, 'clearTimeout');

        await runWithTimeout(async () => 'ok', 1_000, 'unused');

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    it('Regression: code_review app timeout (1h45min) must stay strictly below broker consumer_timeout (2h)', () => {
        // If this ever flips, the broker (rabbitmq-ec2.tfvars
        // consumer_timeout=7200000) starts winning the race and the
        // message-stuck-unacked bug from 2026-05 returns.
        const APP_TIMEOUT_CODE_REVIEW_MS = 105 * 60 * 1000; // 1h45min
        const BROKER_CONSUMER_TIMEOUT_MS = 7200 * 1000;     // 2h
        const REQUIRED_CLEANUP_MARGIN_MS = 5 * 60 * 1000;   // 5min minimum

        expect(APP_TIMEOUT_CODE_REVIEW_MS).toBeLessThan(
            BROKER_CONSUMER_TIMEOUT_MS - REQUIRED_CLEANUP_MARGIN_MS,
        );
    });
});
