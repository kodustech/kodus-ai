import { composeAbortSignal } from './parent-signal-compose';

describe('composeAbortSignal', () => {
    it('is a no-op when no parent signal is provided', () => {
        const local = new AbortController();
        const detach = composeAbortSignal(undefined, local);

        expect(local.signal.aborted).toBe(false);
        expect(detach).toBeInstanceOf(Function);
        // Calling detach must not throw even when no listener was attached.
        expect(() => detach()).not.toThrow();
    });

    it('aborts the local controller synchronously when the parent is already aborted', () => {
        const parent = new AbortController();
        parent.abort();
        const local = new AbortController();

        composeAbortSignal(parent.signal, local);

        expect(local.signal.aborted).toBe(true);
    });

    it('aborts the local controller when the parent aborts later', () => {
        const parent = new AbortController();
        const local = new AbortController();

        composeAbortSignal(parent.signal, local);

        expect(local.signal.aborted).toBe(false);
        parent.abort();
        expect(local.signal.aborted).toBe(true);
    });

    it('invokes the onAbort callback exactly once before aborting', () => {
        const parent = new AbortController();
        const local = new AbortController();
        const onAbort = jest.fn();

        composeAbortSignal(parent.signal, local, onAbort);
        parent.abort();
        parent.abort(); // second abort is a no-op on the same controller

        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(local.signal.aborted).toBe(true);
    });

    it('returns a detach function that removes the listener so the parent does not retain the local controller', () => {
        const parent = new AbortController();
        const local = new AbortController();

        const detach = composeAbortSignal(parent.signal, local);
        detach();
        parent.abort();

        // After detach, parent aborting must NOT propagate.
        expect(local.signal.aborted).toBe(false);
    });

    it('does not double-abort if local is already aborted when parent fires', () => {
        const parent = new AbortController();
        const local = new AbortController();
        local.abort(); // local fired first (e.g. internal AGENT_TIMEOUT_MS)
        const onAbort = jest.fn();

        composeAbortSignal(parent.signal, local, onAbort);
        parent.abort();

        // The compose helper installed a listener; parent abort still invokes
        // the callback. AbortController.abort() on an already-aborted
        // controller is idempotent, so this is safe.
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(local.signal.aborted).toBe(true);
    });
});
