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
});
