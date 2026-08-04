"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Image } from "@components/ui/image";
import { Page } from "@components/ui/page";
import { type LLMConfigStatus } from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import {
    ExternalLinkIcon,
    GitBranchIcon,
    InfoIcon,
    PackageIcon,
} from "lucide-react";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "src/core/components/ui/tabs";

import type { BYOKConfig } from "../_types";
import { groupModelsByProvider, hasVisibleModels } from "../_utils";
import { ModelOverridesBanner } from "./model-overrides-banner";
import { ModelsTab } from "./tabs/models-tab";
import { RoutingTab } from "./tabs/routing-tab";

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
                    The API key is not shown for security. Connecting a model
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

export const ByokPageClient = ({
    config,
    llmConfigStatus,
    teamId,
    costByModelId,
    periodLabel,
    costRangeQuery,
}: {
    config: BYOKConfig | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
    teamId?: string;
    costByModelId?: Record<string, ByokModelCost>;
    periodLabel?: string;
    costRangeQuery?: string;
}) => {
    // First-run (D-UI-FIRSTRUN): no non-managed credential carries a model yet.
    // Both tabs stay reachable — Routing shows its own "connect a provider
    // first" affordance rather than being locked.
    const firstRun = !hasVisibleModels(config);

    // Count of connected providers (non-managed credentials carrying ≥1 model)
    // — drives the Providers tab count badge.
    const providersCount = groupModelsByProvider(config).filter(
        (group) => group.models.length > 0,
    ).length;

    // Nag about an env-based LLM only when no BYOK model is configured at all.
    const showEnvNotice = !!llmConfigStatus?.env.configured && firstRun;

    // Controlled tab value so cross-tab affordances (e.g. Routing's empty-state
    // "Go to Providers") can switch tabs via a callback — no DOM scraping.
    const [tab, setTab] = useState("providers");

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title className="text-balance">
                        Bring your own key
                    </Page.Title>
                    <Page.Description className="flex flex-col gap-2 text-pretty">
                        <span>
                            Connect the providers your team uses, then choose
                            which model reviews each thing.
                        </span>
                        <span className="flex items-center gap-2">
                            <span className="w-9 shrink-0">
                                <Image
                                    src="/assets/images/kody_safety.png"
                                    alt="Kody guarding your key"
                                />
                            </span>
                            <span>
                                You pay your provider directly —{" "}
                                <strong className="text-text-primary font-medium">
                                    Kodus never sees your key
                                </strong>
                                .
                                <a
                                    href="https://docs.kodus.io/how_to_use/en/byok"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary-light ml-2 inline-flex items-center gap-1 text-xs hover:underline">
                                    Learn more
                                    <ExternalLinkIcon size={12} />
                                </a>
                            </span>
                        </span>
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                {showEnvNotice && llmConfigStatus && (
                    <EnvConfigNotice env={llmConfigStatus.env} />
                )}

                <ModelOverridesBanner teamId={teamId} />

                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList>
                        <TabsTrigger value="providers">
                            <span className="flex items-center gap-2">
                                <PackageIcon size={15} />
                                Providers
                                <Badge
                                    variant="helper"
                                    size="xs"
                                    className="min-w-5 justify-center px-1.5 tabular-nums">
                                    {providersCount}
                                </Badge>
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="routing">
                            <span className="flex items-center gap-2">
                                <GitBranchIcon size={15} />
                                Routing
                            </span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="providers">
                        <ModelsTab
                            config={config}
                            costByModelId={costByModelId}
                            teamId={teamId}
                            periodLabel={periodLabel}
                            costRangeQuery={costRangeQuery}
                            llmConfigStatus={llmConfigStatus}
                        />
                    </TabsContent>

                    <TabsContent value="routing">
                        <RoutingTab
                            config={config}
                            llmConfigStatus={llmConfigStatus}
                            onGoToProviders={() => setTab("providers")}
                        />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};
