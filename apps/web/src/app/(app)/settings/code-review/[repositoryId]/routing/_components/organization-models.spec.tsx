/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useEffect, useState } from "react";
import { TooltipProvider } from "@components/ui/tooltip";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { BYOKConfig } from "src/features/ee/byok/_types";

import { OrganizationModels, OtherTaskModels } from "./organization-models";
import {
    useOrganizationRouting,
    type OrganizationRoutingController,
} from "./use-organization-routing";

const get = jest.fn();
const put = jest.fn();
jest.mock("@services/organizationParameters/fetch", () => ({
    getBYOK: (...args: unknown[]) => get(...args),
    createOrUpdateOrganizationParameter: (...args: unknown[]) => put(...args),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
let config: BYOKConfig;
let status: LLMConfigStatus;
let latest: OrganizationRoutingController;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const base = (): BYOKConfig => ({
    version: 2,
    credentials: [
        {
            id: "credential-a",
            provider: "openai",
            apiKey: "••••",
            settings: { custom: "kept" },
        },
        { id: "credential-b", provider: "anthropic", apiKey: "an...xyz" },
    ],
    models: [
        { id: "a", credentialId: "credential-a", model: "model-alpha" },
        { id: "b", credentialId: "credential-b", model: "model-beta" },
        { id: "c", credentialId: "credential-a", model: "model-gamma" },
    ],
    routing: {
        defaultModelId: "a",
        fallbackModelId: "b",
        taskOverrides: {
            riskAssessment: "c",
            codeReview: "b",
            conversation: "c",
        },
    },
});
const metadata = (value: BYOKConfig): LLMConfigStatus => ({
    source: "byok",
    byok: { configured: true, providerId: "openai", model: "model-alpha" },
    env: { configured: false },
    models: value.models.map((model) => ({
        modelId: model.id,
        model: model.model,
        credentialId: model.credentialId,
        providerId: value.credentials.find(
            (credential) => credential.id === model.credentialId,
        )?.provider,
        resolvable: true,
        capabilities: {
            structuredOutput: "json_schema",
            toolCalling: "native",
        },
    })),
    modelRouting: {
        defaultModelId: value.routing?.defaultModelId,
        fallbackModelId: value.routing?.fallbackModelId,
        riskAssessment: {
            modelId:
                value.routing?.taskOverrides?.riskAssessment ??
                value.routing?.defaultModelId,
            inherited: !value.routing?.taskOverrides?.riskAssessment,
        },
    },
    reviewModels: {
        balanced: {
            modelId:
                value.routing?.taskOverrides?.codeReview ??
                value.routing?.defaultModelId,
            inherited: !value.routing?.taskOverrides?.codeReview,
        },
        heavy: {
            modelId:
                value.routing?.taskOverrides?.codeReviewHeavy ??
                value.routing?.defaultModelId,
            inherited: !value.routing?.taskOverrides?.codeReviewHeavy,
        },
    },
});

function Harness({
    canEdit = true,
    heavyAllowed = true,
}: {
    canEdit?: boolean;
    heavyAllowed?: boolean;
}) {
    const controller = useOrganizationRouting({
        teamId: "team",
        enabled: true,
        canEdit,
        status,
    });
    useEffect(() => {
        latest = controller;
    });
    const [error, setError] = useState("");
    return (
        <>
            <OrganizationModels
                controller={controller}
                canEdit={canEdit}
                heavyAllowed={heavyAllowed}
            />
            <OtherTaskModels
                controller={controller}
                canEdit={canEdit}
                heavyAllowed={heavyAllowed}
            />
            <button
                disabled={
                    !controller.dirty ||
                    !controller.canEdit ||
                    !!controller.validationError
                }
                onClick={async () => {
                    try {
                        await controller.save();
                        setError("");
                    } catch (error) {
                        setError((error as Error).message);
                    }
                }}>
                Save models
            </button>
            <button onClick={controller.reset}>Reset models</button>
            <output data-testid="draft">
                {JSON.stringify(controller.routing)}
            </output>
            {error && <p role="alert">{error}</p>}
        </>
    );
}
function mount(props: { canEdit?: boolean; heavyAllowed?: boolean } = {}) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return {
        client,
        ...render(
            <QueryClientProvider client={client}>
                <TooltipProvider>
                    <Harness {...props} />
                </TooltipProvider>
            </QueryClientProvider>,
        ),
    };
}
const draft = () => JSON.parse(screen.getByTestId("draft").textContent!);

it("refuses a newly selected provider that disconnected while another stayed connected", async () => {
    mount();
    await waitFor(() => expect(latest.canEdit).toBe(true));
    act(() => latest.setDefault("b"));
    const fresh = clone(status);
    fresh.models.find((model) => model.modelId === "b")!.resolvable = false;
    await expect(latest.save(fresh)).rejects.toThrow(
        "A selected provider is unavailable",
    );
    expect(put).not.toHaveBeenCalled();
    expect(latest.dirty).toBe(true);
});

const choose = async (label: string, model: RegExp) => {
    fireEvent.click(await screen.findByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name: model }));
};
beforeAll(() => {
    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = jest.fn();
    Element.prototype.hasPointerCapture = jest.fn(() => false);
    Element.prototype.releasePointerCapture = jest.fn();
});
beforeEach(() => {
    config = base();
    status = metadata(config);
    get.mockReset().mockImplementation(async () => clone(config));
    put.mockReset().mockResolvedValue(true);
});

it("searches on the first character with mixed providers and disabled cells", async () => {
    status.models[2].resolvable = false;
    mount();
    fireEvent.click(
        await screen.findByRole("combobox", { name: "Default model" }),
    );
    expect(() =>
        fireEvent.change(screen.getByPlaceholderText("Search models…"), {
            target: { value: "b" },
        }),
    ).not.toThrow();
    expect(screen.getByRole("option", { name: /Model Beta/ })).toBeVisible();
    expect(
        screen.queryByRole("option", { name: /Model Alpha/ }),
    ).not.toBeInTheDocument();
});
it("renders a missing saved default without throwing and lets the user repair it", async () => {
    config.routing!.defaultModelId = "deleted";
    mount();
    expect(
        await screen.findByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Select a connected model");
    await choose("Default model", /Model Alpha/);
    expect(draft().defaultModelId).toBe("a");
    expect(screen.getByRole("button", { name: "Save models" })).toBeEnabled();
});
it("handles an old model missing its name and still searches by its slot id", async () => {
    config.models.push({
        id: "broken",
        credentialId: "credential-a",
    } as BYOKConfig["models"][number]);
    mount();
    fireEvent.click(
        await screen.findByRole("combobox", { name: "Default model" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
        target: { value: "broken" },
    });
    expect(screen.getByRole("option", { name: /broken/ })).toBeVisible();
});
it("changing the default clears an equal fallback and makes equal task pins inherit", async () => {
    mount();
    await choose("Default model", /Model Beta/);
    expect(draft().fallbackModelId).toBeUndefined();
    expect(draft().taskOverrides.codeReview).toBeUndefined();
    expect(draft().taskOverrides.riskAssessment).toBe("c");
    expect(draft().taskOverrides.conversation).toBe("c");
});
it("keeps fallback distinct from default and lets the user remove it", async () => {
    mount();
    fireEvent.click(
        await screen.findByRole("combobox", { name: "Fallback model" }),
    );
    expect(
        screen.queryByRole("option", { name: /Model Alpha/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "None" }));
    expect(draft().fallbackModelId).toBeUndefined();
});
it("re-reads the config, preserves a new provider/model and unrelated routes, and never resubmits masks as keys", async () => {
    mount();
    await choose("Default model", /Model Gamma/);
    config.credentials.push({
        id: "new-provider",
        provider: "openai_compatible",
        apiKey: "••••",
        settings: {
            baseURL: "https://another.example/v1",
            openrouterProviderOrder: ["kept"],
        },
    });
    config.models.push({
        id: "new-model",
        credentialId: "new-provider",
        model: "new-model",
    });
    config.routing!.taskOverrides!.customAgent = "new-model";
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const blob = put.mock.calls[0][1] as BYOKConfig;
    expect(blob.models).toEqual(config.models);
    expect(blob.routing?.defaultModelId).toBe("c");
    expect(blob.routing?.taskOverrides?.customAgent).toBe("new-model");
    expect(
        blob.credentials.every((credential) => credential.apiKey === ""),
    ).toBe(true);
    expect(blob.credentials[0].settings).toEqual({ custom: "kept" });
    expect(blob.credentials[2].settings).toEqual(
        config.credentials[2].settings,
    );
    expect(screen.getByRole("button", { name: "Save models" })).toBeDisabled();
});
it("does not overwrite a credential rotated while editing", async () => {
    mount();
    await choose("Fallback model", /Model Gamma/);
    config.credentials[0].apiKey = "new...key";
    config.credentials[0].settings = { baseURL: "https://rotated.example/v1" };
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].credentials[0]).toMatchObject({
        apiKey: "",
        settings: { baseURL: "https://rotated.example/v1" },
    });
});
it("refuses a model deleted in another tab and retains the local draft", async () => {
    mount();
    await choose("Default model", /Model Gamma/);
    config.models = config.models.filter((model) => model.id !== "c");
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    expect(
        await screen.findByText(
            "A selected model was removed. Refresh and choose a connected model.",
        ),
    ).toBeVisible();
    expect(put).not.toHaveBeenCalled();
    expect(draft().defaultModelId).toBe("c");
    expect(
        await screen.findByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent("Select a connected model");
});
it("refuses saving after the last provider disappears", async () => {
    mount();
    await choose("Default model", /Model Gamma/);
    get.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    expect(
        await screen.findByText(
            "Connect an AI provider before changing routing.",
        ),
    ).toBeVisible();
    expect(put).not.toHaveBeenCalled();
});
it("retains edits on an API failure and reset discards them without writing", async () => {
    put.mockRejectedValue(new Error("Fixture save failure"));
    mount();
    await choose("Default model", /Model Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
        "Fixture save failure",
    );
    expect(draft().defaultModelId).toBe("c");
    fireEvent.click(screen.getByRole("button", { name: "Reset models" }));
    expect(draft().defaultModelId).toBe("a");
    expect(put).toHaveBeenCalledTimes(1);
});
it("locks redundant model controls with one model while retaining the current default", async () => {
    config.models = config.models.slice(0, 1);
    config.credentials = config.credentials.slice(0, 1);
    config.routing = { defaultModelId: "a" };
    status = metadata(config);
    mount();
    for (const label of [
        "Default model",
        "Fallback model",
        "Risk assessment model",
        "Balanced model",
        "Heavy model",
    ])
        expect(
            await screen.findByRole("combobox", { name: label }),
        ).toBeDisabled();
    expect(screen.getByText(/One connected model/)).toBeVisible();
});
it("does not let read-only users mutate routing", async () => {
    mount({ canEdit: false });
    expect(
        await screen.findByRole("combobox", { name: "Default model" }),
    ).toBeDisabled();
    await act(async () => latest.setDefault("b"));
    expect(draft().defaultModelId).toBe("a");
    expect(put).not.toHaveBeenCalled();
});
it("keeps Heavy locked by plan while keeping its saved route intact", async () => {
    config.routing!.taskOverrides!.codeReviewHeavy = "c";
    mount({ heavyAllowed: false });
    await screen.findByRole("combobox", { name: "Default model" });
    expect(
        screen.queryByRole("combobox", { name: "Heavy model" }),
    ).not.toBeInTheDocument();
    expect(
        screen.getByText("Available on Teams and Enterprise."),
    ).toBeVisible();
    await choose("Fallback model", /Model Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save models" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].routing.taskOverrides.codeReviewHeavy).toBe(
        "c",
    );
});
it("disables unsupported review picks before save and exposes the reason", async () => {
    status.models[2].capabilities = {
        structuredOutput: "none",
        toolCalling: "none",
    };
    mount();
    fireEvent.click(
        await screen.findByRole("combobox", { name: "Balanced model" }),
    );
    expect(screen.getByRole("option", { name: /Model Gamma/ })).toHaveAttribute(
        "aria-disabled",
        "true",
    );
    expect(put).not.toHaveBeenCalled();
});
