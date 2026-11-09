/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ByokPageClient } from "./page.client";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBlock = jest.fn();
let mockQuery = "";
let mockDirty = false;
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    useSearchParams: () => new URLSearchParams(mockQuery),
}));
jest.mock("src/core/utils/navigation-guard", () => ({
    hasUnsavedChanges: () => mockDirty,
    triggerNavigationBlock: () => mockBlock(),
}));
jest.mock("./tabs/models-tab", () => ({
    ModelsTab: ({
        onOpenRouting,
    }: {
        onOpenRouting: (anchor: string) => void;
    }) => (
        <button onClick={() => onOpenRouting("task:codeReviewHeavy")}>
            Used in Heavy
        </button>
    ),
}));
jest.mock("./spend-limit-section", () => ({
    SpendLimitSection: () => <p>Budget content</p>,
}));
jest.mock("./model-overrides-banner", () => ({
    ModelOverridesBanner: () => null,
}));
jest.mock("./env-config-notice", () => ({ EnvConfigNotice: () => null }));
const mount = () =>
    render(
        <ByokPageClient
            config={{
                version: 2,
                credentials: [{ id: "c", provider: "openai" }],
                models: [{ id: "m", credentialId: "c", model: "gpt-4o" }],
            }}
            llmConfigStatus={null}
        />,
    );
beforeEach(() => {
    mockQuery = "";
    mockDirty = false;
    mockPush.mockReset();
    mockReplace.mockReset();
    mockBlock.mockReset();
    window.location.hash = "";
});
it("keeps Providers and Budget and exposes a single canonical routing entry", () => {
    mount();
    expect(screen.getByRole("tab", { name: /Providers/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Budget" })).toBeVisible();
    expect(
        screen.queryByRole("tab", { name: "Routing" }),
    ).not.toBeInTheDocument();
    expect(
        screen.getByRole("link", { name: "Configure routing" }),
    ).toHaveAttribute("href", "/settings/code-review/global/routing");
});
it("sends a Used in chip to the matching model row on the new screen", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Used in Heavy" }));
    expect(mockPush).toHaveBeenCalledWith(
        "/settings/code-review/global/routing#task%3AcodeReviewHeavy",
    );
});
it("keeps the unsaved-changes guard when leaving Providers for Routing", () => {
    mount();
    mockDirty = true;
    fireEvent.click(screen.getByRole("button", { name: "Used in Heavy" }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockBlock).toHaveBeenCalledTimes(1);
});
it("also replaces an old client-side tab link and keeps its supported anchor", async () => {
    mockQuery = "tab=routing";
    window.location.hash = "#fallback";
    mount();
    await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith(
            "/settings/code-review/global/routing#fallback",
        ),
    );
});
