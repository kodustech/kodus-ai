"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { changeStatusKodyRules } from "@services/kodyRules/fetch";
import { KodyRulesStatus, type KodyRule } from "@services/kodyRules/types";
import { useSuspenseGetCodeReviewParameter } from "@services/parameters/hooks";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";

import { StepIndicators } from "../_components/step-indicators";

const KodyRuleCard = ({
    rule,
    selected,
    repositoryName,
    onToggle,
}: {
    rule: KodyRule;
    selected: boolean;
    repositoryName?: string;
    onToggle: () => void;
}) => {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggle();
                }
            }}
            className={cn(
                "flex flex-row items-start gap-4 rounded-xl border p-4 text-left transition-colors",
                selected
                    ? "border-primary-light bg-primary-light/5"
                    : "border-card-lv3 hover:border-card-lv3/80",
            )}>
            <div className="flex flex-1 flex-col gap-2">
                <div className="flex flex-col gap-1">
                    <div className="flex items-start justify-between gap-3">
                        <span className="text-sm font-semibold">
                            {rule.title}
                        </span>

                        {rule.severity && (
                            <IssueSeverityLevelBadge severity={rule.severity} />
                        )}
                    </div>
                </div>

                <span className="text-text-secondary line-clamp-3 text-xs">
                    {rule.rule}
                </span>
            </div>
            <Checkbox checked={selected} />
        </div>
    );
};

export default function CustomizeTeamPage() {
    const router = useRouter();
    const { userId } = useAuth();
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetCodeReviewParameter(teamId);
    const [selectedRules, setSelectedRules] = useState<string[]>([]);
    const [isSavingRules, setIsSavingRules] = useState(false);
    const [noRulesTimeoutReached, setNoRulesTimeoutReached] = useState(false);

    const {
        data: pendingRules = [],
        isLoading: isPendingRulesLoading,
        isFetching: isPendingRulesFetching,
        isRefetching: isPendingRulesRefetching,
    } = useFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.PENDING_IDE_RULES,
        { params: { teamId } },
        !!teamId,
        {
            refetchInterval: (data) => {
                const rules = Array.isArray(data) ? data : [];
                const hasValidRules = rules.some((rule) => rule?.uuid);
                return hasValidRules ? false : 15000;
            },
            staleTime: 10000,
        },
    );

    const repositoryNameById = useMemo(() => {
        return new Map(
            (configValue?.repositories || []).map((repo) => [
                repo.id,
                repo.name,
            ]),
        );
    }, [configValue?.repositories]);

    const pendingRuleIds = useMemo(
        () =>
            safeArray<KodyRule>(pendingRules)
                .map((rule) => rule.uuid)
                .filter((id): id is string => Boolean(id)),
        [pendingRules],
    );

    const areArraysEqual = (a: string[], b: string[]) => {
        if (a.length !== b.length) return false;
        const sortedA = [...a].sort();
        const sortedB = [...b].sort();
        return sortedA.every((id, idx) => id === sortedB[idx]);
    };

    useEffect(() => {
        setSelectedRules((prev) => {
            if (areArraysEqual(prev, pendingRuleIds)) return prev;

            if (prev.length === 0) return pendingRuleIds;

            const stillSelected = prev.filter((id) =>
                pendingRuleIds.includes(id),
            );
            const newOnes = pendingRuleIds.filter(
                (id) => !stillSelected.includes(id),
            );

            const next = [...stillSelected, ...newOnes];

            if (areArraysEqual(prev, next)) return prev;

            return next;
        });
    }, [pendingRuleIds]);

    useEffect(() => {
        if (pendingRuleIds.length > 0) {
            setNoRulesTimeoutReached(false);
            return;
        }

        const timeout = setTimeout(() => setNoRulesTimeoutReached(true), 15000);

        return () => clearTimeout(timeout);
    }, [pendingRuleIds]);

    // Keep the loading state visible while there are no rules and the timeout hasn't been reached
    const showEmptyStateSpinner = useMemo(
        () => pendingRules.length === 0 && !noRulesTimeoutReached,
        [noRulesTimeoutReached, pendingRules.length],
    );

    const isSyncingRules = pendingRules.length === 0 && !noRulesTimeoutReached;
    const noRulesAfterSync = pendingRules.length === 0 && noRulesTimeoutReached;
    const hasSelectedRules = selectedRules.length > 0;

    const highlightItems = useMemo(() => {
        const items: Array<{
            label: string;
            helper?: string;
            accent?: boolean;
        }> = [
            { label: "Bugs" },
            { label: "Security" },
            { label: "Performance" },
        ];

        if (hasSelectedRules) {
            items.push({
                label: "Team standards",
                helper:
                    selectedRules.length === 1
                        ? "1 custom rule selected"
                        : `${selectedRules.length} custom rules selected`,
                accent: true,
            });
        }

        return items;
    }, [hasSelectedRules, selectedRules.length]);

    const toggleRule = (ruleId: string) => {
        if (!ruleId) return;

        setSelectedRules((prev) =>
            prev.includes(ruleId)
                ? prev.filter((id) => id !== ruleId)
                : [...prev, ruleId],
        );
    };

    const handleApplyAndContinue = async () => {
        if (!teamId) {
            toast({
                variant: "danger",
                description: "Missing team. Please try again.",
            });
            return;
        }

        const pendingIds = pendingRules
            .map((rule) => rule.uuid)
            .filter((id): id is string => Boolean(id));

        try {
            setIsSavingRules(true);
            const toActivate = selectedRules;
            const toDelete = pendingIds.filter(
                (id) => !selectedRules.includes(id),
            );
            const prUrls = new Set<string>();

            if (toActivate.length) {
                const activationResult = await changeStatusKodyRules(
                    toActivate,
                    KodyRulesStatus.ACTIVE,
                );

                if (
                    isCentralizedPrResponse(activationResult) &&
                    activationResult.prUrl
                ) {
                    prUrls.add(activationResult.prUrl);
                }
            }

            if (toDelete.length) {
                const deletionResult = await changeStatusKodyRules(
                    toDelete,
                    KodyRulesStatus.DELETED,
                );

                if (
                    isCentralizedPrResponse(deletionResult) &&
                    deletionResult.prUrl
                ) {
                    prUrls.add(deletionResult.prUrl);
                }
            }

            const hasCentralizedPr = prUrls.size > 0;

            toast(
                hasCentralizedPr
                    ? {
                          variant: "success",
                          title: "Rules Proposed In PR",
                          description: `Your changes were queued in centralized config PR: ${Array.from(prUrls)[0]}`,
                      }
                    : {
                          variant: "success",
                          title: "Rules Saved",
                          description: "Rules saved for your team.",
                      },
            );
            router.push("/setup/choosing-a-pull-request");
        } catch (error) {
            console.error("Error reviewing fast IDE rules", error);
            toast({
                variant: "danger",
                description:
                    "We couldn't save your selection. Please try again.",
            });
        } finally {
            setIsSavingRules(false);
        }
    };

    const handleSkip = () => {
        if (isSavingRules) return;

        router.push("/setup/choosing-a-pull-request");
    };

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 overflow-hidden">
                    <h1 className="text-2xl font-bold">
                        Teach Kody how your team builds software
                    </h1>
                    <p className="text-text-secondary mt-2 text-base">
                        Rules add your team’s standards to every review. By
                        default, Kody checks bugs, security, and performance.
                    </p>
                    <div className="mt-5 flex flex-col gap-2">
                        {highlightItems.map((item) => (
                            <div
                                key={item.label}
                                className={cn(
                                    "bg-card-lv2 border-border flex items-center justify-between gap-2 rounded-xl border p-3 text-sm transition-all duration-300",
                                    item.accent &&
                                        "border-primary-light/80 bg-primary-light/5 ring-primary-light/30 shadow-[0_12px_40px_rgba(0,0,0,0.06)] ring-1",
                                )}>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold">
                                        {item.label}
                                    </span>
                                    {item.helper ? (
                                        <span className="text-primary-light text-xs font-semibold">
                                            {item.helper}
                                        </span>
                                    ) : null}
                                </div>
                                <Checkbox
                                    checked={true}
                                    variant={"primary-dark"}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <Heading variant="h2">Review your Kody Rules</Heading>

                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex flex-col gap-1">
                                <span className="text-text-secondary text-sm">
                                    These rules are auto detected from your
                                    codebase. Review what matters now and adjust
                                    anytime in Settings.
                                </span>
                            </div>
                        </div>

                        <div className="flex flex-row items-center justify-end">
                            {pendingRules.length > 0 && (
                                <span className="text-primary-light shrink-0 text-xs">
                                    {selectedRules.length} selected of{" "}
                                    {pendingRules.length}
                                </span>
                            )}
                        </div>

                        {pendingRules.length === 0 ? (
                            <div className="bg-card-lv1 border-card-lv3 text-text-secondary flex flex-col gap-2 rounded-xl border p-4 text-sm">
                                <div className="text-text-primary flex items-center gap-2 font-semibold">
                                    {showEmptyStateSpinner ? <Spinner /> : null}
                                    <span>
                                        {noRulesTimeoutReached
                                            ? "No rules generated this time"
                                            : "We're syncing rules from your repositories"}
                                    </span>
                                </div>

                                <span className="text-text-primary">
                                    {noRulesTimeoutReached
                                        ? "We couldn't find rules from your repo configs this time. You can continue and add or edit rules later in Settings."
                                        : "Kody is scanning your config files and preparing recommendations. They will appear here automatically, and you can keep going in the meantime."}
                                </span>
                            </div>
                        ) : (
                            <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto pr-1">
                                {pendingRules.map((rule) => {
                                    const ruleId = rule.uuid ?? rule.title;

                                    return (
                                        <KodyRuleCard
                                            key={ruleId}
                                            rule={rule}
                                            repositoryName={
                                                rule.repositoryId
                                                    ? repositoryNameById.get(
                                                          rule.repositoryId,
                                                      )
                                                    : undefined
                                            }
                                            selected={
                                                !!rule.uuid &&
                                                selectedRules.includes(
                                                    rule.uuid,
                                                )
                                            }
                                            onToggle={() =>
                                                rule.uuid &&
                                                toggleRule(rule.uuid)
                                            }
                                        />
                                    );
                                })}
                            </div>
                        )}

                        <span className="text-text-secondary text-right text-xs">
                            You can edit these rules anytime in Settings.
                        </span>
                    </div>

                    <div className="flex flex-col items-center gap-4">
                        {!isSyncingRules && !noRulesAfterSync && (
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                loading={isSavingRules}
                                disabled={
                                    isSavingRules ||
                                    (pendingRules.length > 0 &&
                                        selectedRules.length === 0)
                                }
                                onClick={handleApplyAndContinue}>
                                {`Apply ${selectedRules.length} and continue`}
                            </Button>
                        )}

                        {noRulesAfterSync && (
                            <Button
                                size="lg"
                                variant="primary"
                                className="w-full"
                                onClick={handleSkip}
                                disabled={isSavingRules}>
                                Continue to the next step
                            </Button>
                        )}

                        {!noRulesAfterSync && (
                            <button
                                type="button"
                                onClick={handleSkip}
                                disabled={isSavingRules}
                                className={cn(
                                    "text-primary-light text-sm hover:underline",
                                    isSavingRules && "opacity-60",
                                )}>
                                I'll do this later
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
