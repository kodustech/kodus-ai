/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { hasUnsavedChanges } from "src/core/utils/navigation-guard";

import { ByokPageClient } from "./page.client";

const mockGet = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@services/spend-limit/fetch", () => ({
    getSpendLimitConfig: () => mockGet(),
    getSpendLimitStatus: jest.fn(),
    updateSpendLimit: (...args: unknown[]) => mockUpdate(...args),
}));
const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock("next/navigation", () => ({
    useRouter: () => mockRouter,
    useSearchParams: () => new URLSearchParams("tab=budget"),
}));
jest.mock("./tabs/models-tab", () => ({
    ModelsTab: () => <p>Provider content</p>,
}));
jest.mock("./model-overrides-banner", () => ({
    ModelOverridesBanner: () => null,
}));
jest.mock("./env-config-notice", () => ({ EnvConfigNotice: () => null }));
it("keeps the real Budget draft when Providers is requested and permits leaving after discard", async () => {
    mockGet.mockResolvedValue({
        enabled: false,
        monthlyLimitUsd: 0,
        scope: "total",
        modelPricing: {},
        priceable: true,
        models: [
            {
                model: "gpt-4o",
                source: "catalog",
                priced: true,
                rates: {
                    input: { default: 0.001 },
                    output: { default: 0.002 },
                    cacheRead: { default: 0 },
                    cacheWrite: { default: 0 },
                },
            },
        ],
    });
    const view = render(
        <QueryClientProvider
            client={
                new QueryClient({
                    defaultOptions: { queries: { retry: false } },
                })
            }>
            <ByokPageClient
                config={{
                    version: 2,
                    credentials: [{ id: "c", provider: "openai" }],
                    models: [{ id: "m", credentialId: "c", model: "gpt-4o" }],
                }}
                llmConfigStatus={null}
                teamId="team"
            />
        </QueryClientProvider>,
    );
    const input = await screen.findByLabelText("Monthly limit (US$)");
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
    fireEvent.change(input, { target: { value: "100" } });
    await waitFor(() => expect(hasUnsavedChanges()).toBe(true));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Providers/ }), {
        button: 0,
        ctrlKey: false,
    });
    expect(screen.getByRole("tab", { name: "Budget" })).toHaveAttribute(
        "aria-selected",
        "true",
    );
    expect(input).toHaveValue("100");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Providers/ }), {
        button: 0,
        ctrlKey: false,
    });
    expect(await screen.findByText("Provider content")).toBeVisible();
    expect(mockUpdate).not.toHaveBeenCalled();
    view.unmount();
    expect(hasUnsavedChanges()).toBe(false);
});
