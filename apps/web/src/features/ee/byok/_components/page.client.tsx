"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Page } from "@components/ui/page";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { type LLMConfigStatus } from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { ExternalLinkIcon, InfoIcon } from "lucide-react";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "src/core/components/ui/tabs";

import type { BYOKConfigV2 } from "../_types";
import { hasVisibleModels } from "../_utils";
import { ModelOverridesBanner } from "./model-overrides-banner";
import { BudgetTab } from "./tabs/budget-tab";
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

/**
 * A tab trigger that, when `disabled` (first-run), shows a "Connect a model
 * first." tooltip explaining why it's locked (D-UI-FIRSTRUN). A disabled Radix
 * trigger swallows pointer events, so the tooltip is anchored on a wrapping
 * span that still receives hover/focus.
 */
const GatedTabTrigger = ({
    value,
    disabled,
    children,
}: {
    value: string;
    disabled?: boolean;
    children: React.ReactNode;
}) => {
    if (!disabled) {
        return <TabsTrigger value={value}>{children}</TabsTrigger>;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex" tabIndex={0}>
                    <TabsTrigger value={value} disabled>
                        {children}
                    </TabsTrigger>
                </span>
            </TooltipTrigger>
            <TooltipContent>Connect a model first.</TooltipContent>
        </Tooltip>
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
    config: BYOKConfigV2 | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
    teamId?: string;
    costByModelId?: Record<string, ByokModelCost>;
    periodLabel?: string;
    costRangeQuery?: string;
}) => {
    // First-run (D-UI-FIRSTRUN): no non-managed credential carries a model yet.
    // Only the Models tab is interactive until the org connects its own key.
    const firstRun = !hasVisibleModels(config);

    // Nag about an env-based LLM only when no BYOK model is configured at all.
    const showEnvNotice = !!llmConfigStatus?.env.configured && firstRun;

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

                <ModelOverridesBanner teamId={teamId} />

                <Tabs defaultValue="models">
                    <TooltipProvider>
                        <TabsList>
                            <TabsTrigger value="models">Models</TabsTrigger>
                            <GatedTabTrigger value="routing" disabled={firstRun}>
                                Routing
                            </GatedTabTrigger>
                            <GatedTabTrigger value="budget" disabled={firstRun}>
                                Budget & alerts
                            </GatedTabTrigger>
                        </TabsList>
                    </TooltipProvider>

                    <TabsContent value="models">
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
                        />
                    </TabsContent>

                    <TabsContent value="budget">
                        <BudgetTab config={config} teamId={teamId} />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};
