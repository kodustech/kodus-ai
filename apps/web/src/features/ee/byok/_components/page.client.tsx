"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Badge } from "@components/ui/badge";
import { Page } from "@components/ui/page";
import type {
    LLMConfigStatus,
    LLMProviderModel,
} from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import {
    ExternalLinkIcon,
    GitBranchIcon,
    InfoIcon,
    PackageIcon,
    WalletIcon,
} from "lucide-react";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "src/core/components/ui/tabs";

import { isPlatformFundedProvider } from "../_data/platform-funded";
import type { BYOKConfig } from "../_types";
import { groupModelsByProvider, hasVisibleModels } from "../_utils";
import { ModelOverridesBanner } from "./model-overrides-banner";
import { SpendLimitSection } from "./spend-limit-section";
import { ModelsTab } from "./tabs/models-tab";
import { RoutingTab } from "./tabs/routing-tab";

const providerLabel = (providerId?: string) => {
    switch (providerId) {
        case "kodus":
            return "Kodus";
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
    kodusCatalog,
}: {
    config: BYOKConfig | null | undefined;
    llmConfigStatus: LLMConfigStatus | null;
    teamId?: string;
    costByModelId?: Record<string, ByokModelCost>;
    periodLabel?: string;
    costRangeQuery?: string;
    /** Kodus catalog (name + list price) keyed by model id; only fetched
     *  when the org has the Kodus provider. */
    kodusCatalog?: Record<
        string,
        { name: string; pricing?: LLMProviderModel["pricing"] }
    >;
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

    // A Kodus-routed model makes the prepaid balance load-bearing: the page
    // header says so, and the wallet lives on the Kodus provider card.
    const usesKodusProvider = (config?.credentials ?? []).some((c) =>
        isPlatformFundedProvider(c.provider),
    );
    const searchParams = useSearchParams();
    const requestedTab = searchParams.get("tab");

    // Controlled tab value so cross-tab affordances (e.g. Routing's empty-state
    // "Go to Providers") can switch tabs via a callback — no DOM scraping.
    const [tab, setTab] = useState(
        requestedTab === "routing" || requestedTab === "budget"
            ? requestedTab
            : "providers",
    );

    // A later navigation to ?tab=… while the page is already mounted must
    // still switch tabs — the initializer above only runs once.
    useEffect(() => {
        if (!requestedTab) return;
        if (["providers", "routing", "budget"].includes(requestedTab)) {
            setTab(requestedTab);
        }
    }, [requestedTab]);

    // /byok#kodus (navbar wallet chip, banners, emails, Stripe's return URL)
    // lands on the Kodus provider card. Hash changes do not re-render, so
    // listen for them too — the chip can be clicked while already here.
    useEffect(() => {
        const jump = () => {
            if (window.location.hash !== "#kodus") return;
            setTab("providers");
            // After the tab content mounts.
            requestAnimationFrame(() =>
                document
                    .getElementById("kodus")
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
            );
        };
        jump();
        window.addEventListener("hashchange", jump);
        return () => window.removeEventListener("hashchange", jump);
    }, []);

    // Deep-link target for the Providers-tab "Used in" chips: clicking one
    // switches to Routing and scrolls to the matching row. RoutingTab consumes
    // `routingAnchor` on mount, then clears it via `onScrolled`.
    const [routingAnchor, setRoutingAnchor] = useState<string | null>(null);
    const openRouting = (anchor: string) => {
        setRoutingAnchor(anchor);
        setTab("routing");
    };

    return (
        <Page.Root>
            <Page.Header className="max-w-full px-6">
                <Page.TitleContainer>
                    <Page.Title className="text-balance">
                        AI providers
                    </Page.Title>
                    <Page.Description className="flex flex-col gap-2 text-pretty">
                        <span>
                            Connect the providers your team uses — Kodus credits
                            with no key, or your own keys — then choose which
                            model runs each task.
                        </span>
                        <span className="flex items-center gap-2">
                            <span>
                                {usesKodusProvider ? (
                                    <>
                                        Your own keys are billed by your
                                        provider —{" "}
                                        <strong className="text-text-primary font-medium">
                                            Kodus never sees them
                                        </strong>
                                        . Models routed by Kodus are paid from
                                        your credits.
                                    </>
                                ) : (
                                    <>
                                        You pay your provider directly —{" "}
                                        <strong className="text-text-primary font-medium">
                                            Kodus never sees your key
                                        </strong>
                                        .
                                    </>
                                )}
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

            <Page.Content className="max-w-full px-6">
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
                        <TabsTrigger value="budget">
                            <span className="flex items-center gap-2">
                                <WalletIcon size={15} />
                                Budget
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
                            onOpenRouting={openRouting}
                            kodusCatalog={kodusCatalog}
                        />
                    </TabsContent>

                    <TabsContent value="routing">
                        <RoutingTab
                            config={config}
                            llmConfigStatus={llmConfigStatus}
                            teamId={teamId}
                            onGoToProviders={() => setTab("providers")}
                            scrollAnchor={routingAnchor}
                            onScrolled={() => setRoutingAnchor(null)}
                        />
                    </TabsContent>

                    <TabsContent value="budget">
                        <SpendLimitSection teamId={teamId} />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};
