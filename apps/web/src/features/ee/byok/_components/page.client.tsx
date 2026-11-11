"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import type {
    LLMConfigStatus,
    LLMProviderModel,
} from "@services/organizationParameters/fetch";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { ExternalLinkIcon, PackageIcon, WalletIcon } from "lucide-react";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "src/core/components/ui/tabs";
import {
    hasUnsavedChanges,
    triggerNavigationBlock,
} from "src/core/utils/navigation-guard";

import { isPlatformFundedProvider } from "../_data/platform-funded";
import type { BYOKConfig } from "../_types";
import { groupModelsByProvider, hasVisibleModels } from "../_utils";
import { EnvConfigNotice } from "./env-config-notice";
import { ModelOverridesBanner } from "./model-overrides-banner";
import { routingHref } from "./routing/routing-state";
import { SpendLimitSection } from "./spend-limit-section";
import { ModelsTab } from "./tabs/models-tab";

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
    const firstRun = !hasVisibleModels(config);

    // Count of connected providers (non-managed credentials carrying ≥1 model)
    // — drives the Providers tab count badge.
    const providersCount = groupModelsByProvider(config).filter(
        (group) => group.models.length > 0,
    ).length;

    // Nag about an env-based LLM only when no BYOK model is configured at all —
    // including one that is declared but cannot run, which nothing else shows.
    const showEnvNotice =
        !!(
            llmConfigStatus?.env.configured ||
            llmConfigStatus?.env.invalidReason
        ) && firstRun;

    // A Kodus-routed model makes the prepaid balance load-bearing: the page
    // header says so, and the wallet lives on the Kodus provider card.
    const usesKodusProvider = (config?.credentials ?? []).some((c) =>
        isPlatformFundedProvider(c.provider),
    );
    const searchParams = useSearchParams();
    const router = useRouter();
    const requestedTab = searchParams.get("tab");

    // Controlled tab value so cross-tab affordances (e.g. Routing's empty-state
    // "Go to Providers") can switch tabs via a callback — no DOM scraping.
    const [tab, setTab] = useState(
        requestedTab === "budget" ? requestedTab : "providers",
    );

    // A later navigation to ?tab=… while the page is already mounted must
    // still switch tabs — the initializer above only runs once.
    useEffect(() => {
        if (!requestedTab) return;
        if (requestedTab === "routing") {
            let anchor: string | undefined;
            try {
                anchor = decodeURIComponent(window.location.hash.slice(1));
            } catch {
                /* Ignore malformed legacy anchors. */
            }
            router.replace(routingHref(anchor));
        } else if (["providers", "budget"].includes(requestedTab)) {
            setTab(requestedTab);
        }
    }, [requestedTab, router]);

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
    // opens the canonical Routing screen at the matching model row.
    const openRouting = (anchor: string) => {
        if (hasUnsavedChanges()) {
            triggerNavigationBlock();
            return;
        }
        router.push(routingHref(anchor));
    };

    // Radix unmounts the panel it leaves, and each tab re-seeds its state from
    // `config` on mount — so a tab switch silently threw away an unsaved
    // routing edit. Every switch now goes through the same guard that stops a
    // nav link or the command palette. Returns whether the switch happened.
    function changeTab(next: string): boolean {
        if (next === tab) return true;
        if (hasUnsavedChanges()) {
            triggerNavigationBlock();
            return false;
        }
        setTab(next);
        return true;
    }

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title className="text-balance">
                        AI providers
                    </Page.Title>
                    <Page.Description className="flex flex-col gap-2 text-pretty">
                        <span>
                            {usesKodusProvider
                                ? "Connect the providers your team uses — Kodus credits with no key, or your own keys — then choose which model runs each task."
                                : "Connect the providers your team uses, then choose which model runs each task."}
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
                <Link href={routingHref()} noHoverUnderline>
                    <Button type="button" size="md" variant="helper">
                        Configure routing
                    </Button>
                </Link>
            </Page.Header>

            <Page.Content>
                {showEnvNotice && llmConfigStatus && (
                    <EnvConfigNotice env={llmConfigStatus.env} />
                )}

                <ModelOverridesBanner teamId={teamId} />

                <Tabs value={tab} onValueChange={changeTab}>
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

                    <TabsContent value="budget">
                        <SpendLimitSection
                            teamId={teamId}
                            onGoToProviders={() => changeTab("providers")}
                        />
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};
