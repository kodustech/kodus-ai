import { throttle } from "./throttle";

describe("throttle", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("runs the first call immediately", () => {
        const fn = jest.fn();
        const throttled = throttle(fn, 1_000);

        throttled();

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("folds a burst into one run at the end of the interval", () => {
        const fn = jest.fn();
        const throttled = throttle(fn, 1_000);

        throttled();
        jest.advanceTimersByTime(100);
        throttled();
        jest.advanceTimersByTime(100);
        throttled();
        throttled();

        expect(fn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(799);
        expect(fn).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(2);

        // Nothing arrived after the trailing run, so nothing else fires.
        jest.advanceTimersByTime(5_000);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("runs immediately again once the interval has passed", () => {
        const fn = jest.fn();
        const throttled = throttle(fn, 1_000);

        throttled();
        jest.advanceTimersByTime(1_000);
        throttled();

        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("keeps the interval between a trailing run and the next one", () => {
        const fn = jest.fn();
        const throttled = throttle(fn, 1_000);

        throttled(); // t=0, runs
        jest.advanceTimersByTime(500);
        throttled(); // queued for t=1000
        jest.advanceTimersByTime(500);
        expect(fn).toHaveBeenCalledTimes(2);

        jest.advanceTimersByTime(200);
        throttled(); // t=1200: only 200ms after the trailing run
        expect(fn).toHaveBeenCalledTimes(2);

        jest.advanceTimersByTime(800);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("drops the queued run when cancelled", () => {
        const fn = jest.fn();
        const throttled = throttle(fn, 1_000);

        throttled();
        jest.advanceTimersByTime(100);
        throttled();
        throttled.cancel();
        jest.advanceTimersByTime(5_000);

        expect(fn).toHaveBeenCalledTimes(1);
    });
});
