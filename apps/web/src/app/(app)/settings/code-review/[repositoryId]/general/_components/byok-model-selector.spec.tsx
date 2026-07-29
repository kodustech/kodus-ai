/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@components/ui/tooltip";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import {
    CodeReviewModelDataProvider,
    ScopedCodeReviewConfigProvider,
} from "src/app/(app)/settings/_components/context";
import type { ScopedCodeReviewConfig } from "src/app/(app)/settings/_components/code-review-config-scope";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";
import { BYOKModelSelectorSection } from "./byok-model-selector";

// The selector reads the route (repository scope, no directory) to pick its
// config level. Pin it to a plain repository scope.
jest.mock("next/navigation", () => ({
    useParams: () => ({ repositoryId: "repo-1" }),
    usePathname: () => "/settings/code-review/repo-1/general",
    useSearchParams: () => new URLSearchParams(),
}));

// testBYOKModel transitively imports the authorized-fetch stack (next-auth,
// ESM-only). Stub the fetch module so the spec stays hermetic.
jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOKModel: jest.fn().mockResolvedValue({ ok: true }),
}));

const modelData = {
    llmConfigStatus: {
        source: "byok",
        models: [],
        byok: { configured: true, providerId: "openai", model: "gpt-4o-mini" },
        env: { configured: false },
    } as LLMConfigStatus,
    byokModels: [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-legacy", name: "GPT Legacy" },
    ],
};

// Only byokModel / byokModelId are consulted by the selector; the rest of the
// FormattedConfig shape is irrelevant here, so cast a minimal partial.
const scopedConfig = (
    partial: Partial<Record<"byokModel" | "byokModelId", unknown>>,
): ScopedCodeReviewConfig =>
    ({
        id: "repo-1",
        name: "repo-1",
        displayName: "repo-1",
        isSelected: true,
        ...partial,
    }) as unknown as ScopedCodeReviewConfig;

const FormValuesProbe = () => {
    const values = useWatch();
    return <pre data-testid="form-values">{JSON.stringify(values)}</pre>;
};

const Harness = ({
    config,
}: {
    config: ScopedCodeReviewConfig;
}) => {
    const methods = useForm<CodeReviewFormType>({
        defaultValues: {} as CodeReviewFormType,
    });
    return (
        <TooltipProvider>
            <FormProvider {...methods}>
                <ScopedCodeReviewConfigProvider config={config}>
                    <CodeReviewModelDataProvider value={modelData}>
                        <BYOKModelSelectorSection />
                        <FormValuesProbe />
                    </CodeReviewModelDataProvider>
                </ScopedCodeReviewConfigProvider>
            </FormProvider>
        </TooltipProvider>
    );
};

const formValues = () =>
    JSON.parse(screen.getByTestId("form-values").textContent || "{}");

beforeAll(() => {
    // cmdk / radix reach for these DOM APIs that jsdom doesn't implement.
    Element.prototype.scrollIntoView = jest.fn();
    if (!("ResizeObserver" in globalThis)) {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
    if (!Element.prototype.hasPointerCapture) {
        Element.prototype.hasPointerCapture = jest.fn();
    }
    if (!Element.prototype.setPointerCapture) {
        Element.prototype.setPointerCapture = jest.fn();
    }
    if (!Element.prototype.releasePointerCapture) {
        Element.prototype.releasePointerCapture = jest.fn();
    }
});

describe("BYOKModelSelectorSection — byokModelId re-key", () => {
    it("writes the id override to byokModelId.value (not the legacy byokModel)", async () => {
        render(<Harness config={scopedConfig({})} />);

        // The write target is the Controller field name, surfaced as the
        // trigger's id. It must be the id override, not the legacy name.
        const trigger = screen.getByRole("combobox");
        expect(trigger).toHaveAttribute("id", "byokModelId.value");

        // Selecting a catalog model routes through field.onChange, which is
        // bound to byokModelId.value.
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByText("GPT-4o"));

        const values = formValues();
        expect(values.byokModelId?.value).toBe("gpt-4o");
        expect(values.byokModel).toBeUndefined();
    });

    it("prefers byokModelId over the legacy byokModel when both are present", () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.GLOBAL,
                    },
                    byokModel: {
                        value: "gpt-legacy",
                        level: FormattedConfigLevel.GLOBAL,
                    },
                })}
            />,
        );

        expect(screen.getByText("GPT-4o")).toBeInTheDocument();
        expect(screen.queryByText("GPT Legacy")).not.toBeInTheDocument();
    });

    it("falls back to the legacy byokModel name when byokModelId is absent", () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModel: {
                        value: "gpt-legacy",
                        level: FormattedConfigLevel.GLOBAL,
                    },
                })}
            />,
        );

        // The legacy name still resolves to its catalog label during the
        // compat read window.
        expect(screen.getByText("GPT Legacy")).toBeInTheDocument();
    });
});
