import { runWithBoundedTimeout } from './run-with-bounded-timeout';

describe('runWithBoundedTimeout (consumer cleanup bound)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('resolves with the operation result when it completes in time', async () => {
        const result = await runWithBoundedTimeout(
            Promise.resolve('ok'),
            100,
            'op',
        );
        expect(result).toBe('ok');
    });

    it('rejects with a labeled timeout when the operation exceeds the budget', async () => {
        jest.useFakeTimers();
        const hung = new Promise(() => {}); // never settles

        const p = runWithBoundedTimeout(hung, 10_000, 'inbox.releaseLock');
        // Suppress unhandled rejection before we await
        p.catch(() => {});

        await jest.advanceTimersByTimeAsync(10_000 + 1);

        await expect(p).rejects.toThrow(
            'inbox.releaseLock bounded timeout after 10000ms',
        );
    });

    it('propagates the underlying rejection when the op fails fast', async () => {
        const failing = Promise.reject(new Error('mongo: ECONNRESET'));

        await expect(
            runWithBoundedTimeout(failing, 10_000, 'op'),
        ).rejects.toThrow('mongo: ECONNRESET');
    });

    it('clears the timer when the op resolves (no orphan handles)', async () => {
        const clearSpy = jest.spyOn(global, 'clearTimeout');

        await runWithBoundedTimeout(Promise.resolve('ok'), 10_000, 'op');

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });

    it('clears the timer when the op rejects (no orphan handles)', async () => {
        const clearSpy = jest.spyOn(global, 'clearTimeout');

        await expect(
            runWithBoundedTimeout(
                Promise.reject(new Error('boom')),
                10_000,
                'op',
            ),
        ).rejects.toThrow('boom');

        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
    });
});
