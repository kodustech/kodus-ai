/** @jest-environment jsdom */
/**
 * The reasoning copy the BYOK form shows for each kind of capability answer
 * the production sweep found.
 *
 * The capability objects are not invented here: `CAPABILITY_KINDS` holds the
 * API's answer for a real production (provider, model), and
 * `get-model-capabilities.prod-shapes.spec.ts` fails when the use case stops
 * answering exactly that. So the form is checked against the shape it really
 * receives, and a provider change that moves a model to another kind fails
 * there by name instead of silently testing a different branch here.
 */
import "@testing-library/jest-dom";

import {
    CAPABILITY_KINDS,
    type CapabilityKind,
} from "@libs/organization/application/use-cases/organizationParameters/get-model-capabilities.kinds.fixture";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

import { ByokAdvancedSettings } from "./advanced-settings";

const ALWAYS_ON_COPY = /This model always reasons\. Its level can.t be set/;
const UNSUPPORTED_COPY = /This model doesn.t support reasoning/;

const mockCaps: { current: Record<string, unknown> | undefined } = {
    current: undefined,
};
jest.mock("@services/organizationParameters/hooks", () => ({
    useModelCapabilities: () => ({ data: mockCaps.current }),
}));

function Harness({
    provider,
    model,
    reasoningEffort = null,
}: {
    provider: string;
    model: string;
    reasoningEffort?: string | null;
}) {
    const form = useForm({
        defaultValues: {
            provider,
            model,
            reasoningEffort,
            reasoningConfigOverride: null,
        } as any,
    });
    return (
        <FormProvider {...form}>
            <ByokAdvancedSettings />
        </FormProvider>
    );
}

function renderKind(
    { provider, model, caps }: CapabilityKind,
    reasoningEffort: string | null = null,
) {
    // The response travels as JSON, so the form sees what survives it.
    mockCaps.current = JSON.parse(JSON.stringify(caps));
    render(
        <Harness
            provider={provider}
            model={model}
            reasoningEffort={reasoningEffort}
        />,
    );
    const advanced = screen.queryByText("Advanced settings");
    if (advanced) fireEvent.click(advanced);
}

const toggle = (label: string) =>
    screen.getByText(label, { selector: "button" });

describe("ByokAdvancedSettings — reasoning copy per production capability kind", () => {
    describe("always reasons, no level to send (anthropic_compatible MiniMax-M3.1-Flash)", () => {
        const kind = CAPABILITY_KINDS.alwaysOn;

        it("says it always reasons, not that it has no reasoning", () => {
            renderKind(kind);
            expect(screen.getByText(ALWAYS_ON_COPY)).toBeInTheDocument();
            expect(
                screen.queryByText(UNSUPPORTED_COPY),
            ).not.toBeInTheDocument();
        });

        // Whatever the slot saved, no level control is shown: an Off selected
        // over "always reasons" contradicted the copy (#2036).
        it.each([null, "none", "high"])(
            "shows no level to pick, with %p saved",
            (saved) => {
                renderKind(kind, saved);
                for (const level of [
                    "Off",
                    "Low",
                    "Medium",
                    "High",
                    "Custom",
                ]) {
                    expect(
                        screen.queryByText(level, { selector: "button" }),
                    ).not.toBeInTheDocument();
                }
                expect(screen.queryByRole("radio")).not.toBeInTheDocument();
            },
        );
    });

    describe("no reasoning (openai gpt-4o-mini)", () => {
        const kind = CAPABILITY_KINDS.unsupported;

        it("says it doesn't support reasoning", () => {
            renderKind(kind);
            expect(screen.getByText(UNSUPPORTED_COPY)).toBeInTheDocument();
            expect(screen.queryByText(ALWAYS_ON_COPY)).not.toBeInTheDocument();
        });

        it("locks every level but Off", () => {
            renderKind(kind);
            expect(toggle("Off")).toBeEnabled();
            for (const level of ["Low", "Medium", "High", "Custom"]) {
                expect(toggle(level)).toBeDisabled();
            }
        });
    });

    describe("reasons at some levels (openai gpt-5.4)", () => {
        const kind = CAPABILITY_KINDS.supportedWithLevels;

        it("shows neither the always-on nor the unsupported copy", () => {
            renderKind(kind);
            expect(screen.queryByText(ALWAYS_ON_COPY)).not.toBeInTheDocument();
            expect(
                screen.queryByText(UNSUPPORTED_COPY),
            ).not.toBeInTheDocument();
        });

        it("offers exactly the levels the API listed", () => {
            renderKind(kind);
            expect(toggle("Low")).toBeDisabled();
            for (const level of ["Off", "Medium", "High", "Custom"]) {
                expect(toggle(level)).toBeEnabled();
            }
        });
    });

    describe("a Kimi brand model that always thinks (moonshot kimi-k3.1-pro)", () => {
        // The brand exposes reasoning, so the form must not show the
        // always-on copy or lock the levels behind it.
        const kind = CAPABILITY_KINDS.brandAlwaysThinking;

        it("shows neither copy and leaves the levels open", () => {
            renderKind(kind);
            expect(screen.queryByText(ALWAYS_ON_COPY)).not.toBeInTheDocument();
            expect(
                screen.queryByText(UNSUPPORTED_COPY),
            ).not.toBeInTheDocument();
            for (const level of ["Low", "Medium", "High", "Custom"]) {
                expect(toggle(level)).toBeEnabled();
            }
        });

        // It cannot be turned off, and the Test refuses an Off for it.
        it("does not offer Off", () => {
            renderKind(kind);
            expect(toggle("Off")).toBeDisabled();
        });
    });

    // #2653: the form showed Off selected and let it be picked, and the Test
    // then refused it ("claude-sonnet-5-5 always reasons and can't be turned
    // off").
    describe("a Claude that refuses Off (anthropic claude-sonnet-5-5)", () => {
        const kind = CAPABILITY_KINDS.claudeAlwaysThinking;
        const selected = () =>
            ["Off", "Low", "Medium", "High", "Custom"].filter(
                (level) => toggle(level).getAttribute("data-state") === "on",
            );

        it("does not offer Off, and offers the levels the API listed", () => {
            renderKind(kind);
            expect(toggle("Off")).toBeDisabled();
            for (const level of ["Low", "Medium", "High", "Custom"]) {
                expect(toggle(level)).toBeEnabled();
            }
        });

        it("shows nothing selected when no level is saved, not Off", () => {
            renderKind(kind);
            expect(selected()).toEqual([]);
        });

        it("clears an Off saved before, instead of keeping it selected", () => {
            renderKind(kind, "none");
            expect(selected()).toEqual([]);
        });

        it("keeps a saved level", () => {
            renderKind(kind, "high");
            expect(selected()).toEqual(["High"]);
        });
    });
});
