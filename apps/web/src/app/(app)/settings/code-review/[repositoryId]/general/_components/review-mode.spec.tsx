/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@components/ui/tooltip";
import type { LLMConfigStatus } from "@services/organizationParameters/fetch";
import { FormProvider, useForm } from "react-hook-form";
import {
    CodeReviewModelDataProvider,
    ScopedCodeReviewConfigProvider,
} from "src/app/(app)/settings/_components/context";
import type { ScopedCodeReviewConfig } from "src/app/(app)/settings/_components/code-review-config-scope";

import { FormattedConfigLevel, type CodeReviewFormType } from "../../../_types";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { ReviewMode } from "./review-mode";

jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    usePathname: () => "/settings/code-review/repo-1/general",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ repositoryId: "repo-1" }),
}));

const status = (over: Partial<LLMConfigStatus> = {}): LLMConfigStatus =>
    ({
        source: "byok",
        models: [
            { modelId: "m-a", model: "model-a", resolvable: true },
            { modelId: "m-b", model: "model-b", resolvable: true },
        ],
        byok: { configured: true, providerId: "openai", model: "model-a" },
        env: { configured: false },
        reviewModels: {
            balanced: { modelId: "m-a", inherited: true },
            heavy: { modelId: "m-b", inherited: false },
        },
        ...over,
    }) as LLMConfigStatus;

const scopedConfig = (partial: Record<string, unknown> = {}) =>
    ({
        id: "repo-1",
        name: "repo-1",
        displayName: "repo-1",
        isSelected: true,
        reviewMode: { value: "balanced", level: FormattedConfigLevel.DEFAULT },
        ...partial,
    }) as unknown as ScopedCodeReviewConfig;

const TEAMS = {
    valid: true,
    subscriptionStatus: "active",
    planType: "teams_byok",
    numberOfLicenses: 5,
} as const;
const FREE = { ...TEAMS, planType: "free_byok" } as const;

const Harness = ({
    llmConfigStatus,
    config = scopedConfig(),
    license = TEAMS,
}: {
    llmConfigStatus: LLMConfigStatus | null;
    config?: ScopedCodeReviewConfig;
    license?: typeof TEAMS | typeof FREE;
}) => {
    const methods = useForm<CodeReviewFormType>({
        defaultValues: {} as CodeReviewFormType,
    });
    return (
        <SubscriptionProvider
            license={license as any}
            usersWithAssignedLicense={[]}>
            <TooltipProvider>
                <FormProvider {...methods}>
                    <ScopedCodeReviewConfigProvider config={config}>
                        <CodeReviewModelDataProvider
                            value={{ llmConfigStatus, byokModels: [] }}>
                            <ReviewMode />
                        </CodeReviewModelDataProvider>
                    </ScopedCodeReviewConfigProvider>
                </FormProvider>
            </TooltipProvider>
        </SubscriptionProvider>
    );
};

describe("ReviewMode", () => {
    it("locks Heavy with the plan tag on free, and keeps Balanced pickable", () => {
        render(<Harness llmConfigStatus={status()} license={FREE} />);

        const [balanced, heavy] = screen.getAllByRole("radio");
        expect(heavy).toBeDisabled();
        expect(balanced).not.toBeDisabled();
        expect(screen.getByText("Teams/Enterprise")).toBeInTheDocument();
    });

    it("lets Teams pick Heavy, with no plan tag", () => {
        render(<Harness llmConfigStatus={status()} />);

        expect(screen.getAllByRole("radio")[1]).not.toBeDisabled();
        expect(screen.queryByText("Teams/Enterprise")).not.toBeInTheDocument();
    });

    it("shows each mode's model read-only, with the routing link, and follows the picked mode", () => {
        render(<Harness llmConfigStatus={status()} />);

        expect(
            screen.getByText("Organization default · Model A"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: /View organization routing/ }),
        ).toHaveAttribute("href", "/byok?tab=routing");
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
        expect(
            screen.getByText(/Selected mode: Balanced · Model: Model A/),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("radio", { name: /Heavy/ }));

        expect(
            screen.getByText(/Selected mode: Heavy · Model: Model B/),
        ).toBeInTheDocument();
    });

    it("explains that a second model is needed when only one is connected", () => {
        render(
            <Harness
                llmConfigStatus={status({
                    models: [
                        { modelId: "m-a", model: "model-a", resolvable: true },
                    ],
                })}
            />,
        );

        expect(screen.getByText(/your only connected model/)).toBeInTheDocument();
        expect(screen.queryByText(/Selected mode/)).not.toBeInTheDocument();
    });

    it("says the scope's own model runs both modes", () => {
        render(
            <Harness
                llmConfigStatus={status()}
                config={scopedConfig({
                    byokModelId: {
                        value: "m-b",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );

        expect(
            screen.getByText(/Both modes use Model B, the model set for this scope/),
        ).toBeInTheDocument();
    });

    it("shows no models without a BYOK config", () => {
        render(
            <Harness
                llmConfigStatus={status({
                    byok: { configured: false },
                    reviewModels: undefined,
                })}
            />,
        );

        expect(screen.getByText("Review mode")).toBeInTheDocument();
        expect(screen.queryByText("Review models")).not.toBeInTheDocument();
    });
});
