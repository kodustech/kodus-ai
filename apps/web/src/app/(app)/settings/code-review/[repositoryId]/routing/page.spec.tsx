/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { ReviewRoutingSummary } from "../general/_components/review-routing-summary";
import RoutingPage from "./page";

let mockRepo = "global";
let mockTeam: string | undefined = "team";
let mockDirectory: string | undefined;
let mockCanEdit = true;
let mockOrgEdit = true;
let mockOrgRead = true;
let mockOrgUpdate = false;
let mockProviderError = false;
let mockProviderChecking = false;
let mockHeavy = true;
let mockConfig: any;
const mockStatus: any = {
    source: "byok",
    models: [
        {
            modelId: "a",
            model: "model-a",
            providerId: "openai",
            credentialId: "cred",
            resolvable: true,
            capabilities: {
                structuredOutput: "json_schema",
                toolCalling: "native",
            },
        },
        {
            modelId: "b",
            model: "model-b",
            providerId: "openai",
            credentialId: "cred",
            resolvable: true,
            capabilities: {
                structuredOutput: "json_schema",
                toolCalling: "native",
            },
        },
        {
            modelId: "c",
            model: "risk-model",
            providerId: "openai",
            credentialId: "cred",
            resolvable: true,
            capabilities: {
                structuredOutput: "json_schema",
                toolCalling: "native",
            },
        },
    ],
    byok: {
        configured: true,
        model: "model-a",
        providerId: undefined as string | undefined,
    },
    env: { configured: false },
    reviewModels: {
        balanced: { modelId: "a", inherited: true },
        heavy: { modelId: "b", inherited: false },
    },
    reviewModelsByOverride: {
        a: { balanced: "a", heavy: "a" },
        b: { balanced: "b", heavy: "b" },
        c: { balanced: "c", heavy: "c" },
        rejected: { balanced: "a", heavy: "b" },
    },
    modelRouting: {
        defaultModelId: "a",
        fallbackModelId: "b",
        riskAssessment: { modelId: "c", inherited: false },
    },
};
const save = jest.fn();
const saveModels = jest.fn();
const mockReadStatus = jest.fn();
const mockReadModels = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const originalStatus = JSON.parse(JSON.stringify(mockStatus));
let mockByok: BYOKConfig;
jest.mock("src/core/utils/reactQuery", () => ({
    generateQueryKey: (path: string, options?: unknown) => [path, options],
}));
jest.mock("@services/parameters/fetch", () => ({
    createOrUpdateCodeReviewParameter: (...args: unknown[]) => save(...args),
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOKModel: jest.fn(),
    getBYOK: () => mockReadModels(),
    getLLMConfigStatus: () => mockReadStatus(),
    createOrUpdateOrganizationParameter: (...args: unknown[]) =>
        saveModels(...args),
    listModelOverrides: () =>
        Promise.resolve({ overrides: [], mismatchedCount: 0 }),
}));
jest.mock("src/app/(app)/settings/_hooks", () => ({
    useCurrentConfigLevel: () =>
        mockDirectory
            ? "directory"
            : mockRepo === "global"
              ? "global"
              : "repository",
    useCodeReviewRouteParams: () => ({
        repositoryId: mockRepo,
        directoryId: mockDirectory,
    }),
}));
jest.mock("src/app/(app)/settings/_components/context", () => ({
    useCodeReviewConfig: () => mockConfig,
    useInitialTeamId: () => "team",
    useCodeReviewModelData: () => ({
        llmConfigStatus: mockStatus,
        hasConnectedProvider: mockStatus.byok.configured,
        providerStatusError: mockProviderError,
        isCheckingProvider: mockProviderChecking,
        byokModels: [],
    }),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: (action: string, resource: string) =>
        resource === "organization_settings"
            ? action === "read"
                ? mockOrgRead
                : action === "create"
                  ? mockOrgEdit
                  : mockOrgUpdate
            : mockCanEdit,
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
    useSelectedTeamId: () => ({ teamId: mockTeam }),
}));
jest.mock("../../_components/centralized-config-readonly-alert", () => ({
    CentralizedConfigReadOnlyAlert: () => null,
}));
jest.mock("../../_components/override", () => ({
    OverrideIndicatorForm: () => null,
    OverrideIndicator: () => null,
}));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
    redirect: (href: string) => {
        throw new Error(`REDIRECT:${href}`);
    },
    usePathname: () => "/settings/code-review/global/routing",
}));

const leaf = (value: unknown) => ({ value, level: "global" });
const config = (active: boolean) => ({
    riskAssessmentActive: leaf(active),
    reviewMode: leaf("balanced"),
    riskReviewRouting: { noRisk: leaf("balanced"), riskFound: leaf("heavy") },
    byokModelId: leaf(""),
});
const mount = (
    active = false,
    summary = false,
    override: any = {},
    queryClient = new QueryClient(),
) => {
    mockConfig = { ...config(active), ...override };
    let update!: () => void;
    function Harness() {
        const [, force] = useState(0);
        update = () => force((value) => value + 1);
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
    const view = render(
        <QueryClientProvider client={queryClient}>
            <Harness />
        </QueryClientProvider>,
    );
    return { ...view, queryClient, refreshEnvironment: () => act(update) };
};
beforeEach(() => {
    mockTeam = "team";
    mockRepo = "global";
    mockDirectory = undefined;
    mockCanEdit = true;
    mockOrgEdit = true;
    mockOrgRead = true;
    mockOrgUpdate = false;
    mockProviderError = false;
    mockProviderChecking = false;
    Object.assign(mockStatus, JSON.parse(JSON.stringify(originalStatus)));
    mockHeavy = true;
    mockStatus.byok.providerId = undefined;
    mockStatus.byok.configured = true;
    mockByok = {
        version: 2,
        credentials: [{ id: "cred", provider: "openai", apiKey: "masked-key" }],
        models: mockStatus.models.map((model: any) => ({
            id: model.modelId,
            credentialId: "cred",
            model: model.model,
        })),
        routing: {
            defaultModelId: "a",
            fallbackModelId: "b",
            taskOverrides: { codeReviewHeavy: "b", riskAssessment: "c" },
        },
    };
    saveModels.mockReset().mockResolvedValue(true);
    mockReadStatus.mockReset().mockImplementation(async () => mockStatus);
    mockReadModels.mockReset().mockImplementation(async () => mockByok);
    mockPush.mockReset();
    mockRefresh.mockReset();
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

it("shows one configured mode for all PRs when risk is off, with organization defaults above it", async () => {
    mount(false);
    await screen.findByRole("combobox", { name: "Default model" });
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

it("shows both risk outcomes and a separate default for unavailable assessments", async () => {
    mount(true);
    await screen.findByRole("combobox", { name: "Risk assessment model" });
    expect(
        screen.getByRole("combobox", { name: "No risk found" }),
    ).toHaveTextContent("Balanced");
    expect(
        screen.getByRole("combobox", { name: "Risk found" }),
    ).toHaveTextContent("Heavy");
    expect(
        screen.getByRole("combobox", { name: "Risk assessment unavailable" }),
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

it("falls back to the effective organization models when a saved model was deleted", () => {
    mount(true, true, { byokModelId: leaf("deleted-model") });
    expect(screen.getByText("No risk found").parentElement).toHaveTextContent(
        "Model A",
    );
    expect(screen.getByText("Risk found").parentElement).toHaveTextContent(
        "Model B",
    );
    expect(screen.queryByText("deleted-model")).not.toBeInTheDocument();
});

it("shows the server-resolved capability fallback for a configured pin", () => {
    mockStatus.models.push({
        modelId: "rejected",
        model: "not-a-review-model",
        resolvable: true,
    });
    try {
        mount(true, true, { byokModelId: leaf("rejected") });
        expect(
            screen.getByText("No risk found").parentElement,
        ).toHaveTextContent("Model A");
        expect(screen.getByText("Risk found").parentElement).toHaveTextContent(
            "Model B",
        );
    } finally {
        mockStatus.models.pop();
    }
});

it("does not turn a legacy model name into an ID when only the mode changes", async () => {
    mockStatus.byok.providerId = "openai";
    mount(false, false, {
        byokModelId: undefined,
        byokModel: leaf("legacy-custom-model"),
    });
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

it("keeps the summary and its routing link visible without a connected provider", () => {
    mockStatus.byok.configured = false;
    mount(true, true);
    expect(screen.getByText("Risk found").parentElement).toHaveTextContent(
        "Heavy Model B",
    );
    expect(
        screen.getByRole("link", { name: /Configure routing/ }),
    ).toHaveAttribute("href", "/settings/code-review/global/routing");
});

it("opens a locked routing screen without a provider instead of redirecting or allowing edits", () => {
    mockStatus.byok.configured = false;
    mockRepo = "repo";
    mockDirectory = "directory";
    mount();
    expect(screen.getByRole("heading", { name: "Routing" })).toBeVisible();
    expect(
        screen.getByRole("heading", {
            name: "Connect an AI provider to use routing",
        }),
    ).toBeVisible();
    expect(
        screen.getByRole("link", { name: "Connect AI provider" }),
    ).toHaveAttribute("href", "/byok");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
        screen.queryByRole("button", { name: "Save settings" }),
    ).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
});

it("explains who can connect a provider when organization editing is not permitted", () => {
    mockStatus.byok.configured = false;
    mockOrgEdit = false;
    mount();
    expect(
        screen.getByText("Ask an organization admin to connect a provider."),
    ).toBeVisible();
    expect(
        screen.queryByRole("link", { name: "Connect AI provider" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("shows the effective risk model when capability fallback differs from the inherited default", async () => {
    const previous = mockStatus.modelRouting.riskAssessment;
    mockStatus.modelRouting.riskAssessment = { modelId: "b", inherited: true };
    try {
        mount(true);
        expect(await screen.findByText("Uses Model B")).toBeVisible();
        expect(
            screen.queryByText("Uses default model"),
        ).not.toBeInTheDocument();
    } finally {
        mockStatus.modelRouting.riskAssessment = previous;
    }
});

const chooseOrgModel = async (label: string, name: RegExp) => {
    fireEvent.click(await screen.findByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name }));
};
const saveButton = () => screen.getByRole("button", { name: "Save settings" });
const chooseReviewMode = async (label: string, name: string) => {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name }));
};

it("lets an organization-only editor save models without writing review settings", async () => {
    mockCanEdit = false;
    mount();
    expect(screen.getByRole("combobox", { name: "All PRs" })).toBeDisabled();
    await chooseOrgModel("Default model", /Model B/);
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModels).toHaveBeenCalledTimes(1));
    expect(save).not.toHaveBeenCalled();
    expect(saveModels.mock.calls[0][1].routing.defaultModelId).toBe("b");
});
it("lets a review-only editor save modes without fetching or writing credential configuration", async () => {
    mockOrgEdit = false;
    mockOrgRead = false;
    mount();
    expect(
        screen.queryByRole("combobox", { name: "Default model" }),
    ).not.toBeInTheDocument();
    await chooseReviewMode("All PRs", "Heavy");
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(mockReadModels).not.toHaveBeenCalled();
    expect(saveModels).not.toHaveBeenCalled();
});
it("does not confuse Update permission with the API's Create permission for organization routing", async () => {
    mockOrgEdit = false;
    mockOrgUpdate = true;
    mount();
    expect(
        await screen.findByRole("combobox", { name: "Default model" }),
    ).toBeDisabled();
    expect(saveModels).not.toHaveBeenCalled();
});
it("does not save either edit when the organization model write fails", async () => {
    saveModels.mockRejectedValue(new Error("Fixture org save failed"));
    mount();
    await chooseOrgModel("Default model", /Model B/);
    await chooseReviewMode("All PRs", "Heavy");
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveModels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(save).not.toHaveBeenCalled();
    expect(
        screen.getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Model B");
    expect(screen.getByRole("combobox", { name: "All PRs" })).toHaveTextContent(
        "Heavy",
    );
});
it("keeps the unsaved review edit after models save but the review write fails", async () => {
    save.mockRejectedValue(new Error("Fixture review save failed"));
    mount();
    await chooseOrgModel("Default model", /Model B/);
    await chooseReviewMode("All PRs", "Heavy");
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(saveModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "All PRs" })).toHaveTextContent(
        "Heavy",
    );
});
it("rechecks provider status before saving and does not write after the last provider is removed", async () => {
    mount();
    await chooseReviewMode("All PRs", "Heavy");
    mockReadStatus.mockResolvedValue({
        source: "none",
        models: [],
        byok: { configured: false },
        env: { configured: false },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mockReadStatus).toHaveBeenCalled());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(save).not.toHaveBeenCalled();
    expect(saveModels).not.toHaveBeenCalled();
});
it("lets a user discard edits and reconnect instead of trapping navigation after disconnection", async () => {
    const view = mount();
    await chooseReviewMode("All PRs", "Heavy");
    mockStatus.byok.configured = false;
    view.refreshEnvironment();
    fireEvent.click(
        await screen.findByRole("button", {
            name: "Discard changes and connect",
        }),
    );
    expect(mockPush).toHaveBeenCalledWith("/byok");
    expect(save).not.toHaveBeenCalled();
    expect(saveModels).not.toHaveBeenCalled();
});
it("blocks all controls while provider status is being verified and explains a verification failure", async () => {
    mockProviderChecking = true;
    const view = mount(true);
    expect(screen.getByRole("combobox", { name: "Risk found" })).toBeDisabled();
    mockProviderChecking = false;
    mockProviderError = true;
    view.refreshEnvironment();
    expect(
        screen.getByRole("heading", { name: "Could not verify AI providers" }),
    ).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});
it("one connected model does not prevent choosing review depth", async () => {
    mockByok.models = mockByok.models.slice(0, 1);
    mockByok.routing = { defaultModelId: "a" };
    mount();
    expect(
        await screen.findByRole("combobox", { name: "Default model" }),
    ).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "All PRs" })).toBeEnabled();
});

it("refreshes the seeded team's provider cache and replaces a cached overview after saving a scope pin", async () => {
    mockTeam = undefined;
    mockRepo = "stale";
    const queryClient = new QueryClient();
    queryClient.setQueryData(["routing-model-overrides", "team"], {
        overrides: [
            {
                scope: "repository",
                repositoryId: "stale",
                repositoryName: "acme/stale",
                model: "a",
            },
        ],
        mismatchedCount: 0,
    });
    const view = mount(false, false, {}, queryClient);
    fireEvent.click(
        screen.getByRole("combobox", { name: "Code review model override" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: /Model B/ }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).toBeDisabled());
    view.unmount();
    mockRepo = "global";
    mount(false, false, {}, queryClient);
    await screen.findByText(/No repository overrides/);
    expect(screen.queryByText("acme/stale")).not.toBeInTheDocument();
    expect(queryClient.getQueryData(["llm-config-status", "team"])).toEqual(
        mockStatus,
    );
    expect(
        queryClient.getQueryData(["llm-config-status", undefined]),
    ).toBeUndefined();
});

it("shows the environment fallback when no BYOK slot satisfies risk capabilities", async () => {
    mockRepo = "repo";
    mockStatus.modelRouting.riskAssessment = { modelId: null, inherited: true };
    mockStatus.env = { configured: true, model: "environment-risk-model" };
    mount(true);
    expect(await screen.findByText("Environment Risk Model")).toBeVisible();
    expect(screen.queryByText("Uses default model")).not.toBeInTheDocument();
});
