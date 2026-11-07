/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ReviewRoutingSummary } from "../general/_components/review-routing-summary";
import RoutingPage from "./page";

let mockRepo = "global";
let mockDirectory: string | undefined;
let mockCanEdit = true;
let mockOrgEdit = true;
let mockHeavy = true;
let mockConfig: any;
const mockStatus: any = {
    source: "byok",
    models: [
        { modelId: "a", model: "model-a", resolvable: true },
        { modelId: "b", model: "model-b", resolvable: true },
        { modelId: "c", model: "risk-model", resolvable: true },
    ],
    byok: { configured: true, model: "model-a" },
    env: { configured: false },
    reviewModels: {
        balanced: { modelId: "a", inherited: true },
        heavy: { modelId: "b", inherited: false },
    },
    modelRouting: {
        defaultModelId: "a",
        fallbackModelId: "b",
        riskAssessment: { modelId: "c", inherited: false },
    },
};
const save = jest.fn();
jest.mock("src/core/utils/reactQuery", () => ({
    generateQueryKey: (path: string, options?: unknown) => [path, options],
}));
jest.mock("@services/parameters/fetch", () => ({
    createOrUpdateCodeReviewParameter: (...args: unknown[]) => save(...args),
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOKModel: jest.fn(),
}));
jest.mock("src/app/(app)/settings/_hooks", () => ({
    useCodeReviewRouteParams: () => ({
        repositoryId: mockRepo,
        directoryId: mockDirectory,
    }),
}));
jest.mock("src/app/(app)/settings/_components/context", () => ({
    useCodeReviewConfig: () => mockConfig,
    useCodeReviewModelData: () => ({
        llmConfigStatus: mockStatus,
        byokModels: [],
    }),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: (_: unknown, resource: string) =>
        resource === "organization_settings" ? mockOrgEdit : mockCanEdit,
}));
jest.mock(
    "src/features/ee/subscription/_providers/subscription-context",
    () => ({
        useSubscriptionContext: () => ({
            license: {
                valid: true,
                subscriptionStatus: "active",
                planType: mockHeavy ? "teams_byok" : "free_byok",
            },
        }),
    }),
);
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team" }),
}));
jest.mock("../../_components/centralized-config-readonly-alert", () => ({
    CentralizedConfigReadOnlyAlert: () => null,
}));
jest.mock("../../_components/override", () => ({
    OverrideIndicatorForm: () => null,
}));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
    usePathname: () => "/settings/code-review/global/routing",
}));

const leaf = (value: unknown) => ({ value, level: "global" });
const config = (active: boolean) => ({
    riskAssessmentActive: leaf(active),
    reviewMode: leaf("balanced"),
    riskReviewRouting: { noRisk: leaf("balanced"), riskFound: leaf("heavy") },
    byokModelId: leaf(""),
});
const mount = (active = false, summary = false, override: any = {}) => {
    mockConfig = { ...config(active), ...override };
    function Harness() {
        const form = useForm<any>({
            defaultValues: mockConfig,
            disabled: !mockCanEdit,
        });
        return (
            <FormProvider {...form}>
                {summary ? (
                    <>
                        <ReviewRoutingSummary />
                        <button
                            onClick={() =>
                                form.setValue("byokModelId.value", "")
                            }>
                            Clear override
                        </button>
                    </>
                ) : (
                    <RoutingPage />
                )}
            </FormProvider>
        );
    }
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <Harness />
        </QueryClientProvider>,
    );
};
beforeEach(() => {
    mockRepo = "global";
    mockDirectory = undefined;
    mockCanEdit = true;
    mockOrgEdit = true;
    mockHeavy = true;
    save.mockReset().mockResolvedValue(true);
});
beforeAll(() => {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    HTMLElement.prototype.scrollIntoView = jest.fn();
});

it("shows one configured mode for all PRs when risk is off, with organization defaults above it", () => {
    mount(false);
    expect(screen.getByRole("combobox", { name: "All PRs" })).toHaveTextContent(
        "Balanced",
    );
    expect(
        screen.queryByRole("combobox", { name: "Risk found" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Default model")).toBeInTheDocument();
    expect(screen.getByText("Fallback model")).toBeInTheDocument();
    expect(
        screen.queryByText(/Not configured|Runtime|Light/),
    ).not.toBeInTheDocument();
});

it("shows both risk outcomes and a separate default for unavailable assessments", () => {
    mount(true);
    expect(
        screen.getByRole("combobox", { name: "No risk found" }),
    ).toHaveTextContent("Balanced");
    expect(
        screen.getByRole("combobox", { name: "Risk found" }),
    ).toHaveTextContent("Heavy");
    fireEvent.click(screen.getByText("Default review mode · Balanced"));
    expect(
        screen.getByText("Used when risk assessment has no result."),
    ).toBeInTheDocument();
    expect(
        screen.getByRole("combobox", { name: "Default review mode" }),
    ).toHaveTextContent("Balanced");
    expect(screen.getByText("Risk Model")).toBeInTheDocument();
});

it("saves only the changed outcome and retains the inherited other outcome", async () => {
    mount(true);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "No risk found" }), {
        key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Heavy" }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Save settings" }),
        ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
        riskReviewRouting: { noRisk: "heavy" },
    });
});

it("does not change the inactive risk mappings when a fixed mode changes", async () => {
    mount(false);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "All PRs" }), {
        key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Heavy" }));
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Save settings" }),
        ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({ reviewMode: "heavy" });
});

it("resets an unsaved mapping to its loaded value", async () => {
    mount(true);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Risk found" }), {
        key: "Enter",
    });
    fireEvent.click(screen.getByRole("option", { name: "Balanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(
        screen.getByRole("combobox", { name: "Risk found" }),
    ).toHaveTextContent("Heavy");
    expect(save).not.toHaveBeenCalled();
});

it("keeps model configuration read-only for repository admins", () => {
    mockOrgEdit = false;
    mount(true);
    expect(
        screen.queryByRole("link", { name: "Edit models" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Risk found" })).toBeEnabled();
});

it("disables route mutations without settings permission", () => {
    mockCanEdit = false;
    mount(false);
    expect(screen.getByRole("combobox", { name: "All PRs" })).toBeDisabled();
    expect(
        screen.getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();
});

it("summarizes active modes and models in General without editable controls", () => {
    mockRepo = "repo";
    mockDirectory = "dir";
    mount(true, true);
    expect(screen.getByText("No risk found").parentElement).toHaveTextContent(
        "Balanced Model A",
    );
    expect(screen.getByText("Risk found").parentElement).toHaveTextContent(
        "Heavy Model B",
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
        screen.getByRole("link", { name: "Configure routing" }),
    ).toHaveAttribute(
        "href",
        "/settings/code-review/repo/routing?directoryId=dir",
    );
});

it("shows the effective default instead of an unconfigured state when risk is off", () => {
    mount(false, true);
    expect(screen.getByText("All PRs").parentElement).toHaveTextContent(
        "Balanced Model A",
    );
    expect(screen.queryByText(/Not configured/)).not.toBeInTheDocument();
});

it("reflects clearing a scope model immediately, including different Balanced and Heavy organization models", () => {
    mount(true, true, { byokModelId: leaf("c") });
    expect(screen.getAllByText("Risk Model")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear override" }));
    expect(screen.getByText("No risk found").parentElement).toHaveTextContent(
        "Model A",
    );
    expect(screen.getByText("Risk found").parentElement).toHaveTextContent(
        "Model B",
    );
});

it("shows the actual Balanced fallback after a plan downgrade", () => {
    mockHeavy = false;
    mount(false, true, { reviewMode: leaf("heavy") });
    expect(screen.getByText("All PRs").parentElement).toHaveTextContent(
        "Balanced Model A",
    );
});
