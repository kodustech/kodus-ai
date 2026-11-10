/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
    ModelCombobox,
    TaskOverrideGrid,
    type PoolModel,
} from "./task-override-grid";

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
const typeInSearch = (text: string) =>
    fireEvent.change(screen.getByPlaceholderText("Search models…"), {
        target: { value: text },
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
        expect(
            screen.queryByRole("option", { name: /^Claude Sonnet/ }),
        ).not.toBeInTheDocument();
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

describe("TaskOverrideGrid — retained Heavy access and model inheritance", () => {
    const models: PoolModel[] = [
        { id: "a", label: "Claude Sonnet" },
        { id: "b", label: "GPT 5" },
    ];
    const mount = (allowed: boolean) =>
        render(
            <TooltipProvider>
                <TaskOverrideGrid
                    models={models}
                    defaultModelId="a"
                    taskOverrides={{ codeReview: "b" }}
                    onChange={jest.fn()}
                    heavyPlanAllowed={allowed}
                />
            </TooltipProvider>,
        );
    it("keeps the Heavy model locked on free plans", () => {
        mount(false);
        const heavy = screen.getByText("Model for Heavy").parentElement!;
        expect(heavy).toHaveTextContent("Teams/Enterprise");
        expect(heavy.querySelector("[role=combobox]")).toBeNull();
    });
    it("keeps Balanced and Heavy independent with flat default inheritance", () => {
        mount(true);
        const balanced = screen.getByText("Model for Balanced").parentElement!;
        const heavy = screen.getByText("Model for Heavy").parentElement!;
        expect(balanced).toHaveTextContent("GPT 5");
        expect(heavy).toHaveTextContent("Use default · Claude Sonnet");
    });
});
