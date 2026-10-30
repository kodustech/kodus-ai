/**
 * Regression net for the BYOK concurrency limiter's ABORT path — previously
 * untested (no `.abort()` assertion existed anywhere in libs/llm). The abort
 * threading is what lets a cancelled review/conversation stop cleanly instead of
 * holding a concurrency slot; this pins it so a future refactor of `run()`/`drain()`
 * can't silently break it.
 *
 * Covered: already-aborted enqueue, abort while queued (reject + never run + slot
 * freed for the next task), abort-reason propagation, the cleanup-on-start no-op,
 * and the queue-timeout reject.
 */
import { BYOKConcurrencyLimiter } from './byok-limiter';

/** A promise whose settlement the test controls, to pin one task on the slot. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('BYOKConcurrencyLimiter — abort handling', () => {
    it('an already-aborted signal rejects immediately and never runs fn', async () => {
        const limiter = new BYOKConcurrencyLimiter(1);
        const ac = new AbortController();
        ac.abort();
        const fn = jest.fn().mockResolvedValue('x');

        await expect(limiter.run('t', fn, ac.signal)).rejects.toThrow(
            /BYOK-QUEUE-ABORTED/,
        );
        expect(fn).not.toHaveBeenCalled();
    });

    it('propagates the caller abort reason verbatim when it is an Error', async () => {
        const limiter = new BYOKConcurrencyLimiter(1);
        const ac = new AbortController();
        const reason = new Error('caller cancelled the run');
        ac.abort(reason);

        await expect(
            limiter.run('t', jest.fn(), ac.signal),
        ).rejects.toBe(reason);
    });

    it('aborting a QUEUED task rejects it, never runs it, and frees the slot for the next task', async () => {
        const limiter = new BYOKConcurrencyLimiter(1); // one slot
        const a = deferred<string>();
        const fnA = jest.fn(() => a.promise); // holds the only slot
        const fnB = jest.fn().mockResolvedValue('B');
        const fnC = jest.fn().mockResolvedValue('C');

        const pA = limiter.run('A', fnA); // starts immediately (drain is sync)
        const ac = new AbortController();
        const pB = limiter.run('B', fnB, ac.signal); // queued behind A
        const pC = limiter.run('C', fnC); // queued behind B

        // `drain()` starts A synchronously but invokes its fn on a microtask.
        await Promise.resolve();
        expect(fnA).toHaveBeenCalledTimes(1);
        expect(fnB).not.toHaveBeenCalled();

        ac.abort();
        await expect(pB).rejects.toThrow(/BYOK-QUEUE-ABORTED/);
        expect(fnB).not.toHaveBeenCalled();

        // A finishes → the freed slot goes to C, NOT the aborted B.
        a.resolve('A');
        await expect(pA).resolves.toBe('A');
        await expect(pC).resolves.toBe('C');
        expect(fnC).toHaveBeenCalledTimes(1);
        expect(fnB).not.toHaveBeenCalled();
    });

    it('once a task has STARTED, a later abort is a no-op on the limiter (the call owns the signal)', async () => {
        const limiter = new BYOKConcurrencyLimiter(1);
        const d = deferred<string>();
        const ac = new AbortController();

        // With a free slot, A starts synchronously and its queue-abort listener
        // is removed (cleanup-on-start) — so a later abort can't reject it here.
        const p = limiter.run('A', () => d.promise, ac.signal);
        ac.abort();
        d.resolve('done'); // the underlying call settles on its own

        await expect(p).resolves.toBe('done');
    });

    it('rejects a queued task with QUEUE-TIMEOUT after it waits past queueTimeoutMs', async () => {
        jest.useFakeTimers();
        try {
            const limiter = new BYOKConcurrencyLimiter(1);
            const a = deferred<string>();
            const pA = limiter.run('A', () => a.promise); // holds the slot
            const fnB = jest.fn().mockResolvedValue('B');
            const pB = limiter.run('B', fnB, undefined, 50); // 50ms queue cap

            jest.advanceTimersByTime(60);
            await expect(pB).rejects.toThrow(/BYOK-QUEUE-TIMEOUT/);
            expect(fnB).not.toHaveBeenCalled();

            a.resolve('A');
            await expect(pA).resolves.toBe('A');
        } finally {
            jest.useRealTimers();
        }
    });
});
