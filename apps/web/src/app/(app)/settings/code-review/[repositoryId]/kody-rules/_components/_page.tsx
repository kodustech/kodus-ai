"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KodyRulesLimitPopover } from "@components/system/kody-rules-limit-popover";
import { Button } from "@components/ui/button";
import { SvgKodyRulesDiscovery } from "@components/ui/icons/SvgKodyRulesDiscovery";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { PopoverTrigger } from "@components/ui/popover";
import { Skeleton } from "@components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    useKodyRulesLimits,
    useSuspenseGetInheritedKodyRules,
    useSuspenseKodyRulesByRepositoryId,
} from "@services/kodyRules/hooks";
import {
    KodyRuleRequestType,
    KodyRulesStatus,
    KodyRulesType,
    KodyRuleWithInheritanceDetails,
    type KodyRule,
} from "@services/kodyRules/types";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, PlusIcon } from "lucide-react";
import { PageBoundary } from "src/core/components/page-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

import { CodeReviewPagesBreadcrumb } from "../../../_components/breadcrumb";
import { GenerateRulesOptions } from "../../../_components/generate-rules-options";
import GeneratingConfig from "../../../_components/generating-config";
import { KodyRuleAddOrUpdateItemModal } from "../../../_components/modal";
import { PendingMemoriesModal } from "../../../_components/pending-memories-modal";
import { PendingKodyRulesModal } from "../../../_components/pending-rules-modal";
import {
    useFullCodeReviewConfig,
    usePlatformConfig,
} from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { KodyRulesEmptyState } from "./empty";
import { GeneratedMemoriesApprovalSetting } from "./generated-memories-approval";
import { KodyRulesList } from "./list";
import { KodyRulesToolbar, type VisibleScopes } from "./toolbar";

type KodyRulesTab = "review-rules" | "memories" | "configuration";

const TAB_QUERY_PARAM = "tab";
const DEFAULT_TAB: KodyRulesTab = "review-rules";

const getRuleType = (rule: Pick<KodyRule, "type">) =>
    rule.type ?? KodyRulesType.STANDARD;

const KodyRulesPageContent = () => {
    const platformConfig = usePlatformConfig();
    const config = useFullCodeReviewConfig();
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const queryClient = useQueryClient();
    const { teamId } = useSelectedTeamId();
    const kodyRulesLimits = useKodyRulesLimits();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.KodyRules,
        repositoryId,
    );

    const scopeKodyRules = useSuspenseKodyRulesByRepositoryId(
        repositoryId,
        directoryId,
    );

    const {
        directoryRules: inheritedDirectoryRules = [],
        globalRules: inheritedGlobalRules = [],
        repoRules: inheritedRepoRules = [],
    } = useSuspenseGetInheritedKodyRules({
        teamId,
        repositoryId,
        directoryId,
    });

    const { activeRules: kodyRules, pendingRules } = safeArray(
        scopeKodyRules,
    ).reduce<{
        activeRules: KodyRule[];
        pendingRules: KodyRule[];
    }>(
        (result, rule) => {
            switch (rule.status) {
                case KodyRulesStatus.ACTIVE:
                    result.activeRules.push(rule);
                    break;
                case KodyRulesStatus.PENDING:
                    result.pendingRules.push(rule);
                    break;
            }
            return result;
        },
        { activeRules: [], pendingRules: [] },
    );

    const isGlobalView = repositoryId === "global";
    const isRepoView = !isGlobalView && !directoryId;

    const activeTabSearchParam = searchParams.get(TAB_QUERY_PARAM);
    const activeTab: KodyRulesTab =
        activeTabSearchParam === "memories" ||
        activeTabSearchParam === "configuration"
            ? activeTabSearchParam
            : DEFAULT_TAB;

    const [filterQuery, setFilterQuery] = useState("");
    const [visibleScopes, setVisibleScopes] = useState<VisibleScopes>({
        self: true,
        dir: true,
        repo: true,
        global: true,
        disabled: true,
    });

    const getRulesViewState = (ruleType: KodyRulesType) => {
        const activeRulesByType = kodyRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedGlobalRulesByType = inheritedGlobalRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedRepoRulesByType = inheritedRepoRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedDirectoryRulesByType = inheritedDirectoryRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );

        const repositoryOnlyRules =
            directoryId || repositoryId === "global"
                ? []
                : activeRulesByType.filter((rule) => !rule.directoryId);

        const directoryOnlyRules =
            !directoryId || repositoryId === "global"
                ? []
                : activeRulesByType.filter(
                      (rule) => rule.directoryId === directoryId,
                  );

        const sourceRuleSets = [] as (
            | KodyRule
            | KodyRuleWithInheritanceDetails
        )[][];

        if (isGlobalView) {
            sourceRuleSets.push(activeRulesByType);
        } else if (isRepoView) {
            if (visibleScopes.self) sourceRuleSets.push(repositoryOnlyRules);
            if (visibleScopes.global)
                sourceRuleSets.push(inheritedGlobalRulesByType);
        } else {
            if (visibleScopes.self) sourceRuleSets.push(directoryOnlyRules);
            if (visibleScopes.dir)
                sourceRuleSets.push(inheritedDirectoryRulesByType);
            if (visibleScopes.repo)
                sourceRuleSets.push(inheritedRepoRulesByType);
            if (visibleScopes.global)
                sourceRuleSets.push(inheritedGlobalRulesByType);
        }

        const combinedRules = sourceRuleSets.flat();

        const activeRules = visibleScopes.disabled
            ? combinedRules
            : combinedRules.filter(
                  (rule) => !("excluded" in rule) || !rule.excluded,
              );

        const uniqueRulesMap = new Map<
            string,
            KodyRule | KodyRuleWithInheritanceDetails
        >();
        for (const rule of activeRules) {
            if (rule.uuid) {
                uniqueRulesMap.set(rule.uuid, rule);
            }
        }
        const uniqueRules = Array.from(uniqueRulesMap.values());

        const filterQueryLowercase = filterQuery.toLowerCase();
        const rulesToDisplay = !filterQuery
            ? uniqueRules
            : uniqueRules.filter((rule) => {
                  return (
                      rule.title.toLowerCase().includes(filterQueryLowercase) ||
                      rule.path?.toLowerCase().includes(filterQueryLowercase) ||
                      rule.rule.toLowerCase().includes(filterQueryLowercase)
                  );
              });

        const hasAnyRulesInSystem =
            activeRulesByType.length > 0 ||
            inheritedGlobalRulesByType.length > 0 ||
            inheritedRepoRulesByType.length > 0 ||
            inheritedDirectoryRulesByType.length > 0;

        return { rulesToDisplay, hasAnyRulesInSystem };
    };

    const reviewRulesState = useMemo(
        () => getRulesViewState(KodyRulesType.STANDARD),
        [
            visibleScopes,
            filterQuery,
            isGlobalView,
            isRepoView,
            kodyRules,
            inheritedGlobalRules,
            inheritedRepoRules,
            inheritedDirectoryRules,
            directoryId,
            repositoryId,
        ],
    );

    const memoriesState = useMemo(
        () => getRulesViewState(KodyRulesType.MEMORY),
        [
            visibleScopes,
            filterQuery,
            isGlobalView,
            isRepoView,
            kodyRules,
            inheritedGlobalRules,
            inheritedRepoRules,
            inheritedDirectoryRules,
            directoryId,
            repositoryId,
        ],
    );

    const pendingReviewRules = useMemo(
        () =>
            pendingRules.filter(
                (rule) => getRuleType(rule) === KodyRulesType.STANDARD,
            ),
        [pendingRules],
    );

    const pendingMemoryUpdates = useMemo(
        () =>
            pendingRules.filter(
                (rule) =>
                    rule.requestType === KodyRuleRequestType.MEMORY_UPDATE,
            ),
        [pendingRules],
    );

    const pendingMemoryCreations = useMemo(
        () =>
            pendingRules.filter(
                (rule) =>
                    rule.requestType !== KodyRuleRequestType.MEMORY_UPDATE,
            ),
        [pendingRules],
    );

    const handleTabChange = (tab: string) => {
        if (
            tab !== "review-rules" &&
            tab !== "memories" &&
            tab !== "configuration"
        ) {
            return;
        }

        const params = new URLSearchParams(searchParams.toString());
        if (tab === DEFAULT_TAB) {
            params.delete(TAB_QUERY_PARAM);
        } else {
            params.set(TAB_QUERY_PARAM, tab);
        }

        const nextUrl = params.toString()
            ? `${pathname}?${params.toString()}`
            : pathname;

        router.replace(nextUrl);
    };

    const refreshRulesList = async () => {
        await queryClient.resetQueries({
            predicate: (query) =>
                query.queryKey[0] ===
                KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        });

        await queryClient.resetQueries({
            predicate: (query) =>
                query.queryKey[0] ===
                KODY_RULES_PATHS.GET_KODY_RULES_TOTAL_QUANTITY,
        });
    };

    const addNewEmptyRule = async (ruleType: KodyRulesType) => {
        if (activeTab === "configuration") return;

        const directory = config.repositories
            .find((r) => r.id === repositoryId)
            ?.directories?.find((d) => d.id === directoryId);

        const response = await magicModal.show(() => (
            <KodyRuleAddOrUpdateItemModal
                repositoryId={repositoryId}
                directory={directory}
                canEdit={canEdit}
                ruleType={ruleType}
            />
        ));

        if (response) await refreshRulesList();
    };

    const showPendingRules = async (
        rules: KodyRule[],
        entityLabel: "rules" | "memories",
    ) => {
        const response = await magicModal.show(() => (
            <PendingKodyRulesModal
                pendingRules={rules}
                entityLabel={entityLabel}
            />
        ));
        if (response) refreshRulesList();
    };

    const showPendingMemories = async () => {
        const activeMemories = kodyRules.filter(
            (rule) => getRuleType(rule) === KodyRulesType.MEMORY,
        );

        const response = await magicModal.show(() => (
            <PendingMemoriesModal
                pendingNewMemories={pendingMemoryCreations}
                pendingUpdates={pendingMemoryUpdates}
                activeMemories={activeMemories}
            />
        ));

        if (response) refreshRulesList();
    };

    const activeRuleType =
        activeTab === "memories"
            ? KodyRulesType.MEMORY
            : KodyRulesType.STANDARD;

    const currentEntityLabel = activeTab === "memories" ? "memory" : "rule";

    const headerDescription =
        "Review Rules run in the dedicated code review stage. Memories are injected across prompts and conversations to provide persistent context.";

    const showHeaderActions = activeTab !== "configuration";

    const canShowDiscovery = activeTab === "review-rules";

    const pendingMemoriesCount =
        pendingMemoryCreations.length + pendingMemoryUpdates.length;

    const pendingEntityLabel: "rules" | "memories" =
        activeTab === "memories" ? "memories" : "rules";

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Kody Rules" />
            </Page.Header>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Kody Rules</Page.Title>
                    <Page.Description>{headerDescription}</Page.Description>
                </Page.TitleContainer>
                {showHeaderActions && (
                    <div className="flex flex-col gap-2">
                        <Page.HeaderActions className="justify-end">
                            {canShowDiscovery && (
                                <Link href="/library/kody-rules/featured">
                                    <Button
                                        size="md"
                                        decorative
                                        variant="secondary"
                                        leftIcon={<SvgKodyRulesDiscovery />}>
                                        Discovery
                                    </Button>
                                </Link>
                            )}

                            {kodyRulesLimits.canAddMoreRules ? (
                                <Button
                                    size="md"
                                    type="button"
                                    variant="primary"
                                    leftIcon={<PlusIcon />}
                                    disabled={!canEdit}
                                    onClick={() =>
                                        addNewEmptyRule(activeRuleType)
                                    }>
                                    New {currentEntityLabel}
                                </Button>
                            ) : (
                                <KodyRulesLimitPopover
                                    limit={kodyRulesLimits.limit}>
                                    <PopoverTrigger asChild>
                                        <Button
                                            size="md"
                                            type="button"
                                            variant="primary"
                                            leftIcon={<PlusIcon />}
                                            disabled={!canEdit}>
                                            New {currentEntityLabel}
                                        </Button>
                                    </PopoverTrigger>
                                </KodyRulesLimitPopover>
                            )}
                        </Page.HeaderActions>

                        <div className="flex justify-end gap-2">
                            {activeTab === "memories"
                                ? pendingMemoriesCount > 0 && (
                                      <Button
                                          size="md"
                                          variant="helper"
                                          className="border-e-primary-light rounded-e-none border-e-4"
                                          leftIcon={<BellRing />}
                                          onClick={showPendingMemories}>
                                          Review pending memories
                                      </Button>
                                  )
                                : pendingReviewRules.length > 0 && (
                                      <Button
                                          size="md"
                                          variant="helper"
                                          className="border-e-primary-light rounded-e-none border-e-4"
                                          leftIcon={<BellRing />}
                                          onClick={() =>
                                              showPendingRules(
                                                  pendingReviewRules,
                                                  pendingEntityLabel,
                                              )
                                          }>
                                          Check out new {pendingEntityLabel}!
                                      </Button>
                                  )}
                        </div>
                    </div>
                )}
            </Page.Header>
            <Page.Content>
                <Tabs value={activeTab} onValueChange={handleTabChange}>
                    <TabsList>
                        <TabsTrigger value="review-rules">
                            Review Rules
                        </TabsTrigger>
                        <TabsTrigger value="memories">Memories</TabsTrigger>
                        <TabsTrigger value="configuration">
                            Configuration
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="review-rules" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <p className="text-text-secondary text-sm">
                                Review Rules run in the code review pipeline and
                                generate review feedback based on changed files
                                or PR-level context.
                            </p>
                            <KodyRulesToolbar
                                filterQuery={filterQuery}
                                onFilterQueryChange={setFilterQuery}
                                entityLabel="rules"
                                visibleScopes={visibleScopes}
                                onVisibleScopesChange={setVisibleScopes}
                                isDisabled={
                                    !reviewRulesState.hasAnyRulesInSystem
                                }
                                isRepoView={isRepoView}
                                isGlobalView={isGlobalView}
                            />
                            {!reviewRulesState.rulesToDisplay.length ? (
                                <KodyRulesEmptyState
                                    canEdit={canEdit}
                                    entityLabel="rule"
                                    onAddNewRule={() =>
                                        addNewEmptyRule(KodyRulesType.STANDARD)
                                    }
                                />
                            ) : (
                                <KodyRulesList
                                    rules={reviewRulesState.rulesToDisplay}
                                    tab="review-rules"
                                    onAnyChange={refreshRulesList}
                                />
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="memories" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <p className="text-text-secondary text-sm">
                                Memories are persistent contextual instructions
                                injected across generation, safeguard, and
                                conversation prompts.
                            </p>
                            <KodyRulesToolbar
                                filterQuery={filterQuery}
                                onFilterQueryChange={setFilterQuery}
                                entityLabel="memories"
                                visibleScopes={visibleScopes}
                                onVisibleScopesChange={setVisibleScopes}
                                isDisabled={!memoriesState.hasAnyRulesInSystem}
                                isRepoView={isRepoView}
                                isGlobalView={isGlobalView}
                            />
                            {!memoriesState.rulesToDisplay.length ? (
                                <KodyRulesEmptyState
                                    canEdit={canEdit}
                                    entityLabel="memory"
                                    showDiscovery={false}
                                    onAddNewRule={() =>
                                        addNewEmptyRule(KodyRulesType.MEMORY)
                                    }
                                />
                            ) : (
                                <KodyRulesList
                                    rules={memoriesState.rulesToDisplay}
                                    tab="memories"
                                    onAnyChange={refreshRulesList}
                                />
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="configuration" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <GeneratedMemoriesApprovalSetting />

                            {isRepoView && (
                                <Suspense
                                    fallback={<Skeleton className="h-15" />}>
                                    <GenerateRulesOptions />
                                </Suspense>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};

export const KodyRulesPage = () => {
    return (
        <PageBoundary
            errorVariant="card"
            errorMessage="Failed to load Kody Rules. Please try again.">
            <KodyRulesPageContent />
        </PageBoundary>
    );
};
