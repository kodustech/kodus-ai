/** @jest-environment jsdom */
import type { ReactNode } from "react";
import { typedFetch } from "@services/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useCreateCellRegistrationToken } from "./queries";
import { useCreateRuntimeSecret } from "./secrets";

jest.mock("@services/fetch", () => ({ typedFetch: jest.fn() }));
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (path: string) => `/api/proxy${path}`,
}));

// A secret value is sent and never kept: once the dialog that sent it is gone,
// the page's mutation cache holds neither the value nor a one-time token.
const mounted = () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
};

const heldValues = (client: QueryClient) =>
    JSON.stringify(
        client
            .getMutationCache()
            .getAll()
            .map((m) => [m.state.variables, m.state.data]),
    );

describe("what the page keeps after sending a secret", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        (typedFetch as jest.Mock).mockReset();
    });
    afterEach(() => jest.useRealTimers());

    it("forgets the secret's value once the form that sent it is gone", async () => {
        (typedFetch as jest.Mock).mockResolvedValue({
            secretId: "s1",
            name: "NPM_TOKEN",
            hosts: ["registry.npmjs.org"],
        });
        const { client, wrapper } = mounted();
        const { result, unmount } = renderHook(useCreateRuntimeSecret, {
            wrapper,
        });
        await act(() =>
            result.current.mutateAsync({
                name: "NPM_TOKEN",
                hosts: ["registry.npmjs.org"],
                value: "value-that-must-not-stay",
            } as never),
        );
        unmount();
        // A second, not the cache's default five minutes.
        act(() => jest.advanceTimersByTime(1000));
        await waitFor(() =>
            expect(heldValues(client)).not.toContain("value-that-must-not-stay"),
        );
    });

    it("forgets a cell registration token once the dialog that showed it is gone", async () => {
        (typedFetch as jest.Mock).mockResolvedValue({
            token: "kcr_one-time-token",
            expiresAt: "2026-11-18T00:00:00.000Z",
        });
        const { client, wrapper } = mounted();
        const { result, unmount } = renderHook(
            useCreateCellRegistrationToken,
            { wrapper },
        );
        await act(() => result.current.mutateAsync("shared" as never));
        unmount();
        // A second, not the cache's default five minutes.
        act(() => jest.advanceTimersByTime(1000));
        await waitFor(() =>
            expect(heldValues(client)).not.toContain("kcr_one-time-token"),
        );
    });
});
