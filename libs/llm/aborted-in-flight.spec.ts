import { abortedInFlightAttrs } from '@libs/llm/aborted-in-flight';
import { BYOKConcurrencyLimiter } from '@libs/llm/byok-limiter';

/** A limiter with its one slot held, so the next call waits in its queue. */
function busyLimiter() {
    const limiter = new BYOKConcurrencyLimiter(1);
    let release!: () => void;
    const held = limiter.run(
        'holder',
        () => new Promise<void>((r) => (release = r)),
    );
    return { limiter, release: () => (release(), held) };
}

describe('abortedInFlightAttrs (#2389)', () => {
    it('marks a call whose own signal aborted it, with the estimated input', () => {
        const stop = new AbortController();
        stop.abort();
        const attrs = abortedInFlightAttrs(stop.signal, () => ({
            system: 'review this',
            messages: [{ role: 'user', content: 'x'.repeat(400) }],
        }));
        expect(attrs?.abortedInFlight).toBe(true);
        expect(attrs?.abortedInFlightInputTokensEstimate).toBeGreaterThan(0);
    });

    it('marks nothing and reads no prompt when the signal did not abort', () => {
        const prompt = jest.fn(() => 'p');
        expect(
            abortedInFlightAttrs(new AbortController().signal, prompt),
        ).toBeUndefined();
        expect(prompt).not.toHaveBeenCalled();
    });

    it('marks nothing when the abort caught the call still queued for a slot', async () => {
        const { limiter, release } = busyLimiter();
        const stop = new AbortController();
        const queued = limiter
            .run('queued', async () => 'ran', stop.signal)
            .catch((e) => e);
        stop.abort(new Error('lenses stopped'));
        await queued;
        expect(abortedInFlightAttrs(stop.signal, () => 'p')).toBeUndefined();
        await release();
    });

    it('still marks a call that got its slot before the abort', async () => {
        const limiter = new BYOKConcurrencyLimiter(1);
        const stop = new AbortController();
        let started!: () => void;
        const running = new Promise<void>((r) => (started = r));
        const call = limiter
            .run(
                'running',
                () =>
                    new Promise((_, reject) => {
                        started();
                        stop.signal.addEventListener('abort', () =>
                            reject(stop.signal.reason),
                        );
                    }),
                stop.signal,
            )
            .catch((e) => e);
        await running;
        stop.abort(new Error('lenses stopped'));
        await call;
        expect(
            abortedInFlightAttrs(stop.signal, () => 'p')?.abortedInFlight,
        ).toBe(true);
    });

    it('marks nothing when there is no prompt to estimate', () => {
        const stop = new AbortController();
        stop.abort();
        expect(
            abortedInFlightAttrs(stop.signal, () => undefined),
        ).toBeUndefined();
    });
});
