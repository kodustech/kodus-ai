/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import { act, fireEvent, render, screen } from "@testing-library/react";

import type { BYOKConfig } from "../../_types";
import { ModelCombobox, type PoolModel } from "../routing/task-override-grid";
import { RoutingTab } from "./routing-tab";

jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    createOrUpdateOrganizationParameter: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
// The per-repository mirror fetches over react-query; it is not what this spec
// is about.
jest.mock("../per-repository-panel", () => ({
    PerRepositoryPanel: () => null,
}));

beforeAll(() => {
    // Radix Popover and cmdk lean on layout APIs jsdom does not ship.
    global.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = jest.fn();
    Element.prototype.hasPointerCapture = jest.fn(() => false);
    Element.prototype.releasePointerCapture = jest.fn();
});

/** An OpenRouter credential with "Pin providers" set, carrying several models. */
const openRouterConfig = (
    models: BYOKConfig["models"],
    routing: BYOKConfig["routing"] = { defaultModelId: models[0]?.id },
): BYOKConfig => ({
    version: 2,
    credentials: [
        {
            id: "cred-or",
            provider: "openrouter",
            apiKey: "sk...abc",
            settings: {
                openrouterProviderOrder: ["anthropic", "google-vertex"],
                openrouterAllowFallbacks: false,
            },
        },
    ],
    models,
    routing,
});

const MODELS: BYOKConfig["models"] = [
    {
        id: "m-1",
        credentialId: "cred-or",
        model: "anthropic/claude-sonnet-4.5",
    },
    { id: "m-2", credentialId: "cred-or", model: "google/gemini-2.5-pro" },
    { id: "m-3", credentialId: "cred-or", model: "openai/gpt-5" },
];

const openDefaultPicker = () => {
    // The "Model for all tasks" trigger is the first combobox on the tab.
    fireEvent.click(screen.getAllByRole("combobox")[0]);
};

const typeInSearch = (text: string) => {
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
        target: { value: text },
    });
};

describe("RoutingTab — searching the model picker", () => {
    it("filters the default-model picker on the first typed character without throwing", () => {
        render(
            <RoutingTab
                config={openRouterConfig(MODELS)}
                llmConfigStatus={null}
                onGoToProviders={jest.fn()}
            />,
        );

        openDefaultPicker();
        expect(() => act(() => typeInSearch("g"))).not.toThrow();

        // The page is still there, and the filter actually filtered.
        expect(screen.getByText("Routing policy")).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /Gemini/ })).toBeVisible();
        expect(
            screen.queryByRole("option", { name: /Claude Sonnet/ }),
        ).not.toBeInTheDocument();
    });

    it("keeps working when routing.defaultModelId points at a model no longer in models[]", () => {
        render(
            <RoutingTab
                config={openRouterConfig(MODELS, {
                    defaultModelId: "m-deleted",
                })}
                llmConfigStatus={null}
                onGoToProviders={jest.fn()}
            />,
        );

        openDefaultPicker();
        expect(() => act(() => typeInSearch("c"))).not.toThrow();
        expect(screen.getByRole("option", { name: /Claude/ })).toBeVisible();
    });

    it("tolerates a stored model whose `model` id is missing", () => {
        const broken = [
            ...MODELS,
            {
                id: "m-4",
                credentialId: "cred-or",
            } as BYOKConfig["models"][number],
        ];
        render(
            <RoutingTab
                config={openRouterConfig(broken)}
                llmConfigStatus={null}
                onGoToProviders={jest.fn()}
            />,
        );

        openDefaultPicker();
        expect(() => act(() => typeInSearch("g"))).not.toThrow();
        expect(screen.getByRole("option", { name: /Gemini/ })).toBeVisible();
    });
});

describe("ModelCombobox — per-agent picker", () => {
    const pool: PoolModel[] = [
        { id: "m-1", label: "Claude Sonnet 4.5", provider: "openrouter" },
        { id: "m-2", label: "Gemini 2.5 Pro", provider: "openrouter" },
        // A capability-gated (disabled) option renders behind a Tooltip.
        {
            id: "m-3",
            label: "Tiny Model",
            provider: "openrouter",
            capabilities: { structuredOutput: "none", toolCalling: "none" },
        },
        // A label that never resolved.
        { id: "m-4", label: undefined as unknown as string },
    ];

    it("filters on the first character, with the inherited row and a gated option present", () => {
        render(
            <TooltipProvider>
                <ModelCombobox
                    models={pool}
                    gateTask="codeReview"
                    onSelect={jest.fn()}
                    defaultOption={{
                        label: "Use default · Claude Sonnet 4.5",
                        selected: true,
                        onSelect: jest.fn(),
                    }}
                    trigger={<button type="button">pick</button>}
                />
            </TooltipProvider>,
        );

        fireEvent.click(screen.getByText("pick"));
        expect(() => act(() => typeInSearch("g"))).not.toThrow();
        expect(screen.getByRole("option", { name: /Gemini/ })).toBeVisible();
    });

    it("still explains why a gated option is disabled", async () => {
        render(
            <TooltipProvider delayDuration={0}>
                <ModelCombobox
                    models={pool}
                    gateTask="codeReview"
                    onSelect={jest.fn()}
                    trigger={<button type="button">pick</button>}
                />
            </TooltipProvider>,
        );

        fireEvent.click(screen.getByText("pick"));
        const gated = screen.getByRole("option", { name: /Tiny Model/ });
        expect(gated).toHaveAttribute("aria-disabled", "true");

        fireEvent.focus(screen.getByText("Tiny Model").parentElement!);
        expect(
            (await screen.findAllByText(/can't do structured output/))[0],
        ).toBeInTheDocument();
    });
});
