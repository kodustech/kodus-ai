import { pollWhileVisible } from "./visible-polling";

type Visibility = "visible" | "hidden";

const fakePage = () => {
    const listeners = new Set<() => void>();
    const page = {
        visibilityState: "visible" as Visibility,
        addEventListener: jest.fn((_type: string, listener: () => void) => {
            listeners.add(listener);
        }),
        removeEventListener: jest.fn((_type: string, listener: () => void) => {
            listeners.delete(listener);
        }),
    };
    const setVisibility = (state: Visibility) => {
        page.visibilityState = state;
        listeners.forEach((listener) => listener());
    };

    return { page: page as unknown as Document, setVisibility, listeners };
};

describe("pollWhileVisible", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("runs on every interval while the page is visible", () => {
        const run = jest.fn();
        const { page } = fakePage();

        pollWhileVisible(run, 30_000, page);
        expect(run).not.toHaveBeenCalled();

        jest.advanceTimersByTime(90_000);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it("does not run while the page is hidden", () => {
        const run = jest.fn();
        const { page, setVisibility } = fakePage();

        pollWhileVisible(run, 30_000, page);
        setVisibility("hidden");
        jest.advanceTimersByTime(10 * 60_000);

        expect(run).not.toHaveBeenCalled();
    });

    it("catches up once when the page becomes visible after a skipped tick", () => {
        const run = jest.fn();
        const { page, setVisibility } = fakePage();

        pollWhileVisible(run, 30_000, page);
        setVisibility("hidden");
        jest.advanceTimersByTime(5 * 60_000);
        setVisibility("visible");

        expect(run).toHaveBeenCalledTimes(1);

        // Back to the normal cadence, with no second catch-up.
        setVisibility("visible");
        expect(run).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(30_000);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it("does not catch up when no tick was skipped", () => {
        const run = jest.fn();
        const { page, setVisibility } = fakePage();

        pollWhileVisible(run, 30_000, page);
        setVisibility("hidden");
        jest.advanceTimersByTime(10_000);
        setVisibility("visible");

        expect(run).not.toHaveBeenCalled();
    });

    it("stops the timer and the listener", () => {
        const run = jest.fn();
        const { page, setVisibility, listeners } = fakePage();

        const stop = pollWhileVisible(run, 30_000, page);
        setVisibility("hidden");
        jest.advanceTimersByTime(60_000);
        stop();
        expect(listeners.size).toBe(0);

        setVisibility("visible");
        jest.advanceTimersByTime(5 * 60_000);
        expect(run).not.toHaveBeenCalled();
    });
});
