/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import {
    testBYOKModel,
    type LLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import type { ScopedCodeReviewConfig } from "src/app/(app)/settings/_components/code-review-config-scope";
import {
    CodeReviewModelDataProvider,
    ScopedCodeReviewConfigProvider,
} from "src/app/(app)/settings/_components/context";

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
let mockCanProbe = true;
jest.mock("@services/permissions/hooks", () => ({
    usePermission: (action: string) =>
        action === "create" ? mockCanProbe : true,
}));

// The selector routes to the BYOK page from its "Manage models" item; child
// components also read the pathname/params, so stub the whole surface.
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    usePathname: () => "/settings/code-review/repo-1/general",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ repositoryId: "repo-1" }),
}));

const modelData = {
    llmConfigStatus: {
        source: "byok",
        // The selector now offers the org's CONFIGURED models (not the provider
        // catalog), so the selectable list lives here.
        models: [
            {
                modelId: "gpt-4o",
                model: "GPT-4o",
                providerId: "openai",
                credentialId: "cred-openai",
                resolvable: true,
            },
            {
                modelId: "gpt-legacy",
                model: "GPT Legacy",
                providerId: "openai",
                credentialId: "cred-openai",
                resolvable: true,
            },
        ],
        byok: { configured: true, providerId: "openai", model: "gpt-4o-mini" },
        env: { configured: false },
    } as LLMConfigStatus,
    // Provider catalog — no longer consumed by the selector; kept only to
    // satisfy the context shape.
    byokModels: [],
};
const originalModels = JSON.parse(
    JSON.stringify(modelData.llmConfigStatus.models),
);
beforeEach(() => {
    mockCanProbe = true;
    modelData.llmConfigStatus.models = JSON.parse(
        JSON.stringify(originalModels),
    );
    (testBYOKModel as jest.Mock).mockReset().mockResolvedValue({ ok: true });
});

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
    checking = false,
}: {
    config: ScopedCodeReviewConfig;
    checking?: boolean;
}) => {
    const methods = useForm<CodeReviewFormType>({
        defaultValues: {} as CodeReviewFormType,
    });
    return (
        <TooltipProvider>
            <FormProvider {...methods}>
                <ScopedCodeReviewConfigProvider config={config}>
                    <CodeReviewModelDataProvider
                        value={{ ...modelData, isCheckingProvider: checking }}>
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
    it("tests the provider model name instead of the stored BYOK entry id", async () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Test model" }));

        await waitFor(() => {
            expect(testBYOKModel).toHaveBeenCalledWith({
                provider: "openai",
                model: "GPT-4o",
                credentialId: "cred-openai",
            });
            expect(screen.getByText("Model available")).toBeInTheDocument();
        });
    });

    it("writes the id override to byokModelId.value (not the legacy byokModel)", async () => {
        render(<Harness config={scopedConfig({})} />);

        // The write target is the Controller field name, surfaced as the
        // trigger's id. It must be the id override, not the legacy name.
        const trigger = screen.getByRole("combobox");
        expect(trigger).toHaveAttribute("id", "byokModelId.value");

        // Selecting a catalog model routes through field.onChange, which is
        // bound to byokModelId.value.
        fireEvent.click(trigger);
        fireEvent.click(await screen.findByRole("option", { name: /GPT 4o/i }));

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

        expect(screen.getByRole("combobox")).toHaveTextContent("GPT 4o");
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
        expect(screen.getByRole("combobox")).toHaveTextContent("GPT Legacy");
    });
});

describe("BYOKModelSelectorSection — badge/text parity", () => {
    // Regression: the "Overridden" badge read ONLY config.byokModelId while the
    // description text read `config.byokModelId ?? config.byokModel`. A repo
    // override stored under the legacy `byokModel` leaf (any override created
    // before the id migration, and the transient post-save window before the
    // background refetch replaces the config) made the badge vanish while the
    // text still announced the override — the two indicators disagreed.
    it("shows the Overridden badge for a repository-level legacy byokModel override", () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModel: {
                        value: "gpt-legacy",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );

        // The description treats it as an override (it is not the inherited
        // model), so the badge MUST agree.
        expect(
            screen.getByText(/Uses one model for Balanced and Heavy/i),
        ).toBeInTheDocument();
        expect(screen.getByText("Overridden")).toBeInTheDocument();
    });

    it("does NOT show the Overridden badge when the value is inherited", () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.GLOBAL,
                    },
                })}
            />,
        );

        // Inherited (level is the parent GLOBAL, not the current REPOSITORY
        // scope) — no override, so no badge.
        expect(screen.queryByText("Overridden")).not.toBeInTheDocument();
    });
});

describe("selected provider and credential identity", () => {
    it("clears a previous connection verdict after provider status is refreshed, even when metadata is unchanged", async () => {
        (testBYOKModel as jest.Mock).mockResolvedValue({
            ok: true,
            verifiedBy: "probe",
        });
        const config = scopedConfig({
            byokModelId: {
                value: "gpt-4o",
                level: FormattedConfigLevel.REPOSITORY,
            },
        });
        const view = render(<Harness config={config} />);
        fireEvent.click(screen.getByRole("button", { name: "Test model" }));
        await screen.findByText("Connection verified");
        view.rerender(<Harness config={config} checking />);
        expect(screen.getByRole("combobox")).toBeDisabled();
        view.rerender(<Harness config={config} />);
        expect(
            screen.queryByText("Connection verified"),
        ).not.toBeInTheDocument();
    });
    it.each([
        "openai",
        "anthropic",
        "google_gemini",
        "google_vertex",
        "amazon_bedrock",
        "open_router",
        "openai_compatible",
        "kodus",
    ])(
        "probes the selected %s slot instead of the main provider",
        async (providerId) => {
            modelData.llmConfigStatus.models.push({
                modelId: "selected",
                model: "selected-provider-model",
                providerId,
                credentialId: "selected-credential",
                resolvable: true,
            });
            render(
                <Harness
                    config={scopedConfig({
                        byokModelId: {
                            value: "selected",
                            level: FormattedConfigLevel.REPOSITORY,
                        },
                    })}
                />,
            );
            fireEvent.click(screen.getByRole("button", { name: "Test model" }));
            await waitFor(() =>
                expect(testBYOKModel).toHaveBeenCalledWith({
                    provider: providerId,
                    model: "selected-provider-model",
                    credentialId: "selected-credential",
                }),
            );
        },
    );
    it("distinguishes two compatible gateways even when both use the same model name", async () => {
        modelData.llmConfigStatus.models = [
            {
                modelId: "gateway-a",
                model: "gpt-4o",
                providerId: "openai_compatible",
                credentialId: "credential-a",
                baseUrl: "https://first.example/v1",
                resolvable: true,
            },
            {
                modelId: "gateway-b",
                model: "gpt-4o",
                providerId: "openai_compatible",
                credentialId: "credential-b",
                baseUrl: "https://second.example/v1",
                resolvable: true,
            },
        ];
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gateway-b",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );
        expect(screen.getByRole("combobox")).toHaveTextContent(
            "second.example",
        );
        fireEvent.click(screen.getByRole("button", { name: "Test model" }));
        await waitFor(() =>
            expect(testBYOKModel).toHaveBeenCalledWith({
                provider: "openai_compatible",
                model: "gpt-4o",
                credentialId: "credential-b",
            }),
        );
    });
    it("does not expose an organization-only probe to a review-only editor", () => {
        mockCanProbe = false;
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );
        expect(screen.getByRole("combobox")).toBeEnabled();
        expect(
            screen.queryByRole("button", { name: "Test model" }),
        ).not.toBeInTheDocument();
        expect(testBYOKModel).not.toHaveBeenCalled();
    });
    it("cannot show a successful probe for a model selected after that probe started", async () => {
        let finish!: (result: unknown) => void;
        (testBYOKModel as jest.Mock).mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Test model" }));
        fireEvent.click(screen.getByRole("combobox"));
        fireEvent.click(
            await screen.findByRole("option", { name: "GPT Legacy" }),
        );
        finish({ ok: true, verifiedBy: "probe" });
        await waitFor(() =>
            expect(formValues().byokModelId?.value).toBe("gpt-legacy"),
        );
        expect(
            screen.queryByText("Connection verified"),
        ).not.toBeInTheDocument();
    });
    it("restores inheritance without writing a legacy model name into the id field", async () => {
        render(
            <Harness
                config={scopedConfig({
                    byokModel: {
                        value: "gpt-legacy",
                        level: FormattedConfigLevel.REPOSITORY,
                        overriddenValue: "parent-legacy-name",
                        overriddenLevel: FormattedConfigLevel.GLOBAL,
                    },
                })}
            />,
        );
        fireEvent.click(screen.getByRole("combobox"));
        fireEvent.click(
            await screen.findByRole("option", { name: /Use inherited model/ }),
        );
        expect(formValues().byokModelId?.value).toBe("");
        expect(formValues().byokModelId?.value).not.toBe("parent-legacy-name");
    });
    it("does not let a provider error produce a success message", async () => {
        (testBYOKModel as jest.Mock).mockResolvedValue({
            ok: false,
            code: "auth",
            message: "Authentication failed",
        });
        render(
            <Harness
                config={scopedConfig({
                    byokModelId: {
                        value: "gpt-4o",
                        level: FormattedConfigLevel.REPOSITORY,
                    },
                })}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Test model" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Authentication failed",
        );
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
});
