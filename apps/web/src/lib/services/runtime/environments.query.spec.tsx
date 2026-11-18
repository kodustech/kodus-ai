/** @jest-environment jsdom */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

import {
    getRuntimeRun,
    listRuntimeEnvironments,
    listRuntimeEnvironmentStatuses,
} from "./api";
import { useRuntimeEnvironments, useRuntimeRun } from "./queries";

jest.mock("./api", () => ({
    listRuntimeEnvironments: jest.fn(),
    listRuntimeEnvironmentStatuses: jest.fn(),
    getRuntimeEnvironment: jest.fn(),
    getRuntimeRun: jest.fn(),
}));

// WP1: while a setup runs, the screen polls the small status route, and reads
// the environment list (each environment's metrics, Runs and setup) again only
// when the status says something moved, never on a timer.

const T0 = "2026-10-29T12:00:00.000Z";
const T1 = "2026-10-29T12:00:09.000Z";

const busy = {
    environmentId: "env-1",
    repositoryId: "repo-1",
    state: "setting_up",
    setup: { state: "setting_up", steps: [], blockers: [], requestedAt: T0, updatedAt: T0 },
    updatedAt: T0,
};
const idle = { environmentId: "env-2", repositoryId: "repo-2", state: "active", updatedAt: T0 };
const statusOf = (e: typeof busy | typeof idle) => ({
    environmentId: e.environmentId,
    state: e.state,
    ...("setup" in e ? { setup: { state: e.setup.state, requestedAt: e.setup.requestedAt, updatedAt: e.setup.updatedAt } } : {}),
    updatedAt: e.updatedAt,
});
const done = { ...busy, state: "active", setup: { ...busy.setup, state: "active", updatedAt: T1 } };

const list = listRuntimeEnvironments as jest.Mock;
const status = listRuntimeEnvironmentStatuses as jest.Mock;

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {children}
    </QueryClientProvider>
);

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

describe("the environment list while a setup runs", () => {
    beforeEach(() => {
        jest.useFakeTimers({ now: new Date(T0).getTime() + 1_000 });
        list.mockReset();
        status.mockReset();
    });
    afterEach(() => jest.useRealTimers());

    it("polls the status, reads the list again only when it moved, and stops once nothing is busy", async () => {
        list.mockResolvedValue([busy, idle]);
        status.mockResolvedValue([statusOf(busy), statusOf(idle)]);
        const { result } = renderHook(() => useRuntimeEnvironments(), { wrapper });
        await advance(0);
        expect(result.current.data).toHaveLength(2);

        // 9 s of a setup that has not moved: the status thrice, the list never again.
        await advance(9_100);
        expect(status.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(list).toHaveBeenCalledTimes(1);

        // The setup finished: the next status says so, and the list is read once more.
        list.mockResolvedValue([done, idle]);
        status.mockResolvedValue([statusOf(done), statusOf(idle)]);
        await advance(3_100);
        expect(list).toHaveBeenCalledTimes(2);
        expect(result.current.data?.[0].state).toBe("active");

        // Nothing is busy any more: no request at all.
        const asked = status.mock.calls.length;
        await advance(30_000);
        expect(status).toHaveBeenCalledTimes(asked);
        expect(list).toHaveBeenCalledTimes(2);
    });

    it("never polls when no setup is requested or running", async () => {
        list.mockResolvedValue([idle]);
        renderHook(() => useRuntimeEnvironments(), { wrapper });
        await advance(30_000);
        expect(status).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(1);
    });
});

describe("a Run read once for what it fixes when it starts", () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date(T0).getTime() + 1_000 }));
    afterEach(() => jest.useRealTimers());

    it("is never polled on its own, where the Run page polls a live Run every 5 s (WP6)", async () => {
        const get = getRuntimeRun as jest.Mock;
        get.mockReset().mockResolvedValue({ runId: "run-1", state: "testing", updatedAt: T0 });
        renderHook(() => useRuntimeRun("run-1", { poll: false }), { wrapper });
        await advance(30_000);
        expect(get).toHaveBeenCalledTimes(1);
        renderHook(() => useRuntimeRun("run-2"), { wrapper });
        await advance(11_000);
        expect(get.mock.calls.filter(([id]) => id === "run-2").length).toBeGreaterThanOrEqual(3);
    });
});
