import { hardTimeout, timeoutSignal } from '@libs/llm/llm-call';

describe('llm-call timeout primitives', () => {
    describe('timeoutSignal', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });
        afterEach(() => {
            jest.useRealTimers();
        });

        it('does not abort before ms elapses', () => {
            const signal = timeoutSignal(1_000);
            jest.advanceTimersByTime(999);
            expect(signal.aborted).toBe(false);
        });

        it('aborts at exactly ms elapsed', () => {
            const signal = timeoutSignal(1_000);
            jest.advanceTimersByTime(1_000);
            expect(signal.aborted).toBe(true);
        });
    });

    describe('hardTimeout', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });
        afterEach(() => {
            jest.useRealTimers();
        });

        it('resolves with the inner value when the promise settles before timeout', async () => {
            const inner = new Promise<string>((resolve) =>
                setTimeout(() => resolve('done'), 100),
            );
            const wrapped = hardTimeout(inner, 1_000, 'fast-call');

            jest.advanceTimersByTime(100);

            await expect(wrapped).resolves.toBe('done');
        });

        it('rejects with [HARD-TIMEOUT] when the inner promise hangs past ms + 5s grace', async () => {
            // Promise that never settles
            const inner = new Promise<never>(() => {});
            const wrapped = hardTimeout(inner, 1_000, 'stuck-call');

            // Attach catch handler immediately so unhandled rejection doesn't fire
            const result = wrapped.catch((e) => e);

            // Advance past the 1s + 5s grace window
            jest.advanceTimersByTime(6_001);

            const err = await result;
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('[HARD-TIMEOUT]');
            expect((err as Error).message).toContain('stuck-call');
            expect((err as Error).message).toContain('1s');
        });

        it('does not reject before ms + 5s grace elapses', async () => {
            const inner = new Promise<never>(() => {});
            const wrapped = hardTimeout(inner, 1_000, 'still-running');
            let settled = false;
            wrapped.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );

            // 5.999s — just before the 6s grace boundary
            jest.advanceTimersByTime(5_999);
            // Yield microtasks so any settled promise callbacks fire
            await Promise.resolve();
            await Promise.resolve();

            expect(settled).toBe(false);
        });

        it('rejects with the inner error if the inner promise rejects first', async () => {
            const inner = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('inner-fail')), 200),
            );
            const wrapped = hardTimeout(inner, 1_000, 'inner-rejects');

            jest.advanceTimersByTime(200);

            await expect(wrapped).rejects.toThrow('inner-fail');
        });
    });
});
