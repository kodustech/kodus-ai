"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Card, CardContent } from "@components/ui/card";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateOrganizationParameter,
    deleteBYOK,
    type LLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { OrganizationParametersConfigKey } from "@services/parameters/types";
import {
    ExternalLinkIcon,
    InfoIcon,
    LayersIcon,
    PlusIcon,
    ShieldCheckIcon,
    TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ConfirmModal } from "src/core/components/ui/confirm-modal";
import { revalidateServerSidePath } from "src/core/utils/revalidate-server-side";

import type { BYOKConfig } from "../_types";
import { CuratedCatalog } from "./catalog/catalog";
import { ConfiguredSummary } from "./configured-summary";
import { SpendLimitSection } from "./spend-limit-section";

type SlotState = "idle" | "editing";

/**
 * Providers represented in the curated catalog at
 * `_data/curated-models.json`. Configs created against any other provider
 * (Bedrock, Vertex, Novita) can't be re-rendered through the catalog UI,
 * so editing them has to skip straight to the manual wizard.
 */
const CURATED_PROVIDERS = new Set([
    "anthropic",
    "openai",
    "openai_compatible",
    "anthropic_compatible",
    "google_gemini",
    "openrouter",
]);

const isEditableInCatalog = (config: BYOKConfig | undefined): boolean =>
    !!config && CURATED_PROVIDERS.has(config.provider);

const providerLabel = (providerId?: string) => {
    switch (providerId) {
        case "openai":
            return "OpenAI";
        case "openai_compatible":
            return "OpenAI-compatible";
        case "anthropic_compatible":
            return "Anthropic-compatible";
        case "anthropic":
            return "Anthropic";
        case "google_gemini":
            return "Google AI Studio (Gemini)";
        case "google_vertex":
            return "Google Vertex AI";
        default:
            return providerId ?? "Unknown";
    }
};

const EnvDataValue = ({ children }: { children: React.ReactNode }) => (
    <code className="bg-card-lv2 rounded px-1.5 py-0.5 font-mono text-xs break-all">
        {children}
    </code>
);

const EnvConfigNotice = ({ env }: { env: LLMConfigStatus["env"] }) => {
    if (!env.configured) return null;

    return (
        <Alert variant="info">
            <InfoIcon />
            <AlertTitle className="text-balance">
                Kodus is currently using an LLM configured via environment
                variables.
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
                <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
                    {env.model && (
                        <>
                            <dt className="text-text-secondary">Model</dt>
                            <dd>
                                <EnvDataValue>{env.model}</EnvDataValue>
                            </dd>
                        </>
                    )}

                    <dt className="text-text-secondary">Provider</dt>
                    <dd className="text-text-primary">
                        {providerLabel(env.providerId)}
                    </dd>

                    {env.baseUrl && (
                        <>
                            <dt className="text-text-secondary">Endpoint</dt>
                            <dd>
                                <EnvDataValue>{env.baseUrl}</EnvDataValue>
                            </dd>
                        </>
                    )}

                    {env.vertexLocation && (
                        <>
                            <dt className="text-text-secondary">
                                Vertex location
                            </dt>
                            <dd>
                                <EnvDataValue>
                                    {env.vertexLocation}
                                </EnvDataValue>
                            </dd>
                        </>
                    )}
                </dl>

                <p className="text-pretty">
                    The API key is not shown for security. Choosing a model
                    below and saving will{" "}
                    <strong className="text-text-primary font-semibold">
                        override
                    </strong>{" "}
                    this env-based configuration.
                </p>
            </AlertDescription>
        </Alert>
    );
};

const confirmEnvOverride = (): Promise<boolean> =>
    new Promise((resolve) => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title="Override env-based LLM configuration?"
                description="This will replace the LLM provider currently configured in your .env. Kodus will use the key and model you just entered instead."
                confirmText="Override env config"
                variant="primary-dark"
                onConfirm={() => {
                    resolve(true);
                    magicModal.hide();
                }}
                onCancel={() => {
                    resolve(false);
                    magicModal.hide();
                }}
            />
        ));
    });

export const ByokPageClient = ({
    config,
    llmConfigStatus,
    teamId,
}: {
    config: { main: BYOKConfig; fallback: BYOKConfig } | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
    teamId?: string;
}) => {
    const router = useRouter();
    const [mainState, setMainState] = useState<SlotState>(
        config?.main ? "idle" : "editing",
    );
    const [fallbackState, setFallbackState] = useState<SlotState>("idle");
    const [isDeletingMain, setIsDeletingMain] = useState(false);
    const [isDeletingFallback, setIsDeletingFallback] = useState(false);

    /**
     * The catalog UI only knows how to render configs whose provider is in
     * CURATED_PROVIDERS. For Bedrock/Vertex/Novita configs, going through
     * the catalog would force the user to hunt for the "Configure manually"
     * link at the bottom every single edit — bypass it.
     */
    const handleEdit = (slot: "main" | "fallback") => {
        const slotConfig = slot === "main" ? config?.main : config?.fallback;
        if (slotConfig && !isEditableInCatalog(slotConfig)) {
            router.push(`/organization/byok/manual?slot=${slot}`);
            return;
        }
        if (slot === "main") {
            setMainState("editing");
        } else {
            setFallbackState("editing");
        }
    };

    const envIsActiveSource = llmConfigStatus?.source === "env";
    const showEnvNotice =
        !!llmConfigStatus?.env.configured && !config?.main;

    const existingKeyByProvider: Partial<Record<string, string>> = {};
    if (config?.main) {
        existingKeyByProvider[config.main.provider] = config.main.apiKey;
    }
    if (config?.fallback) {
        existingKeyByProvider[config.fallback.provider] = config.fallback.apiKey;
    }

    const onSaveMain = async (newConfig: BYOKConfig) => {
        if (envIsActiveSource) {
            const proceed = await confirmEnvOverride();
            if (!proceed) return;
        }

        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                { main: newConfig },
            );
            toast({ variant: "success", title: "Main model saved" });
            setMainState("idle");
            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({ variant: "danger", title: "Couldn't save main model" });
        }
    };

    const onSaveFallback = async (newConfig: BYOKConfig) => {
        try {
            await createOrUpdateOrganizationParameter(
                OrganizationParametersConfigKey.BYOK_CONFIG,
                { fallback: newConfig },
            );
            toast({ variant: "success", title: "Fallback model saved" });
            setFallbackState("idle");
            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't save fallback model",
                description:
                    "Configure a Main model first — fallback needs one to back up.",
            });
        }
    };

    const onDeleteMain = async () => {
        const ok = await new Promise<boolean>((resolve) => {
            magicModal.show(() => (
                <ConfirmModal
                    open
                    title="Remove main model?"
                    description="Kodus will stop using this key immediately. Any fallback model will also be cleared."
                    confirmText="Remove"
                    variant="primary-dark"
                    onConfirm={() => {
                        resolve(true);
                        magicModal.hide();
                    }}
                    onCancel={() => {
                        resolve(false);
                        magicModal.hide();
                    }}
                />
            ));
        });
        if (!ok) return;

        setIsDeletingMain(true);
        try {
            await deleteBYOK({ configType: "main" });
            toast({ variant: "success", title: "Main model removed" });
            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({ variant: "danger", title: "Couldn't remove main model" });
        } finally {
            setIsDeletingMain(false);
        }
    };

    const onDeleteFallback = async () => {
        const ok = await new Promise<boolean>((resolve) => {
            magicModal.show(() => (
                <ConfirmModal
                    open
                    title="Remove fallback model?"
                    description="Kodus will stop using this fallback immediately. Reviews will rely solely on your main model."
                    confirmText="Remove"
                    variant="primary-dark"
                    onConfirm={() => {
                        resolve(true);
                        magicModal.hide();
                    }}
                    onCancel={() => {
                        resolve(false);
                        magicModal.hide();
                    }}
                />
            ));
        });
        if (!ok) return;

        setIsDeletingFallback(true);
        try {
            await deleteBYOK({ configType: "fallback" });
            toast({ variant: "success", title: "Fallback model removed" });
            await revalidateServerSidePath("/organization/byok");
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't remove fallback model",
            });
        } finally {
            setIsDeletingFallback(false);
        }
    };

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title className="text-balance">
                        Bring your own key
                    </Page.Title>
                    <Page.Description className="flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty">
                        <span>
                            Pick a model for code review. You pay your
                            provider directly — Kodus never sees your key.
                        </span>
                        <a
                            href="https://docs.kodus.io/how_to_use/en/byok"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-light inline-flex items-center gap-1 text-xs hover:underline">
                            Learn more
                            <ExternalLinkIcon size={12} />
                        </a>
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                {showEnvNotice && llmConfigStatus && (
                    <EnvConfigNotice env={llmConfigStatus.env} />
                )}

                <section className="flex flex-col gap-3">
                    <SlotHeader
                        icon={<ShieldCheckIcon size={16} />}
                        title="Main model"
                        description="Used for every review."
                    />

                    {mainState === "idle" && config?.main ? (
                        <ConfiguredSummary
                            config={config.main}
                            isDeleting={isDeletingMain}
                            onChange={() => handleEdit("main")}
                            onDelete={onDeleteMain}
                        />
                    ) : (
                        <CuratedCatalog
                            slot="main"
                            existingConfig={config?.main}
                            existingKeyByProvider={existingKeyByProvider}
                            onSave={onSaveMain}
                            onCancel={
                                config?.main
                                    ? () => setMainState("idle")
                                    : undefined
                            }
                        />
                    )}
                </section>

                {config?.main && (
                    <section className="flex flex-col gap-3">
                        <SlotHeader
                            icon={<LayersIcon size={16} />}
                            title="Fallback model"
                            description="Optional. Used if the main model fails."
                        />

                        {fallbackState === "idle" && config?.fallback ? (
                            <ConfiguredSummary
                                config={config.fallback}
                                isDeleting={isDeletingFallback}
                                onChange={() => handleEdit("fallback")}
                                onDelete={onDeleteFallback}
                            />
                        ) : fallbackState === "idle" ? (
                            <EmptyFallback
                                onAdd={() => setFallbackState("editing")}
                            />
                        ) : (
                            <CuratedCatalog
                                slot="fallback"
                                existingConfig={config?.fallback}
                                existingKeyByProvider={existingKeyByProvider}
                                onSave={onSaveFallback}
                                onCancel={() => setFallbackState("idle")}
                            />
                        )}

                        {config?.fallback && fallbackState === "idle" && (
                            <Button
                                type="button"
                                size="xs"
                                variant="cancel"
                                className="text-danger self-start [--button-foreground:var(--color-danger)]"
                                leftIcon={<TrashIcon />}
                                loading={isDeletingFallback}
                                onClick={onDeleteFallback}>
                                Remove fallback
                            </Button>
                        )}
                    </section>
                )}

                {config?.main && <SpendLimitSection teamId={teamId} />}
            </Page.Content>
        </Page.Root>
    );
};

function SlotHeader({
    icon,
    title,
    description,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
}) {
    return (
        <div className="flex items-center gap-2">
            <span className="text-text-secondary">{icon}</span>
            <div className="flex flex-col">
                <h3 className="text-text-primary text-sm font-semibold text-balance">
                    {title}
                </h3>
                <p className="text-text-tertiary text-xs text-pretty">
                    {description}
                </p>
            </div>
        </div>
    );
}

function EmptyFallback({ onAdd }: { onAdd: () => void }) {
    return (
        <Card color="lv1" className="border-card-lv2 border-dashed">
            <CardContent className="flex items-center justify-between gap-4 py-4">
                <p className="text-text-secondary text-sm text-pretty">
                    Add a fallback so reviews keep running if your main model
                    is rate-limited or down.
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="helper"
                    leftIcon={<PlusIcon />}
                    onClick={onAdd}>
                    Add fallback
                </Button>
            </CardContent>
        </Card>
    );
}
