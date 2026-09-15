"use client";

import { useMemo, type ReactNode } from "react";
import { GateCtaLink } from "@components/system/gate-cta-link";
import { Badge } from "@components/ui/badge";
import { Skeleton } from "@components/ui/skeleton";
import { getKodyRuleSuggestions } from "@services/kodyRules/fetch";
import type {
    KodyRuleSuggestion,
    KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import { useQuery } from "@tanstack/react-query";
import { GitPullRequestIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { cn } from "src/core/utils/components";
import { safeArray } from "src/core/utils/safe-array";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { TimeAgo } from "./data-table-row";
import { HEALTH, HEALTH_WINDOW_DAYS, useKodyRulesHealth } from "./rule-health";

const RECENT_LIMIT = 3;

const Stat = ({
    value,
    label,
    detail,
    locked,
}: {
    value: ReactNode;
    label: string;
    /** Secondary figure under the value (e.g. the rate). */
    detail?: ReactNode;
    /** Cockpit-only metric on a plan without the Cockpit. */
    locked?: boolean;
}) => (
    <div
        className="bg-card-lv1 flex min-w-0 flex-col gap-0.5 px-4 py-3"
        title={
            locked
                ? "Available with the Cockpit (Teams and Enterprise plans)"
                : undefined
        }>
        <span
            className={cn(
                "text-lg leading-none font-semibold tabular-nums",
                locked ? "text-text-tertiary" : "text-text-primary",
            )}>
            {locked ? "—" : value}
        </span>
        <span className="text-text-tertiary text-[11px]">
            {label}
            {!locked && detail && (
                <span className="text-text-secondary"> · {detail}</span>
            )}
        </span>
    </div>
);

/**
 * "Is this rule earning its keep?" — the question behind opening a rule.
 * Health, triggers, implementation and feedback come from the Cockpit's
 * per-rule health table (last 30 days, Cockpit tiers only); triggers, PRs
 * and the recent list come from the rule's own suggestions, which every
 * plan has. Nothing here is invented: a metric we can't fetch renders as a
 * locked dash, never as a number.
 */
export const RuleImpact = ({
    rule,
    seeAll,
}: {
    rule: KodyRuleWithInheritanceDetails;
    /** Link/trigger to the full suggestions list. */
    seeAll?: ReactNode;
}) => {
    // Org-wide health table, shared with the list rows (one request).
    const health = useKodyRulesHealth();
    const canSeeAnalytics = health.enabled;
    const { license } = useSubscriptionContext();
    const healthRow = rule.uuid ? health.byRuleId?.get(rule.uuid) : undefined;

    const suggestions = useQuery({
        queryKey: ["kody-rule-suggestions", rule.uuid],
        queryFn: () => getKodyRuleSuggestions(rule.uuid as string),
        enabled: !!rule.uuid,
        staleTime: 60_000,
    });
    const list = useMemo(
        () =>
            [...safeArray<KodyRuleSuggestion>(suggestions.data)].sort(
                (a, b) =>
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime(),
            ),
        [suggestions.data],
    );
    const prCount = new Set(
        list.map((item) => `${item.repositoryId}#${item.prNumber}`),
    ).size;
    const lastFired = healthRow?.lastTriggeredAt ?? list[0]?.createdAt;
    const isLoading =
        suggestions.isLoading || (canSeeAnalytics && health.isLoading);

    const state = healthRow ? HEALTH[healthRow.state] : null;

    return (
        <section
            aria-label="Rule impact"
            className="border-card-lv3/60 rounded-xl border">
            <header className="border-card-lv3/60 flex items-center justify-between gap-3 border-b px-4 py-2.5">
                <span className="text-sm font-semibold">
                    Impact
                    <span className="text-text-tertiary font-normal">
                        {" "}
                        · last {HEALTH_WINDOW_DAYS} days
                    </span>
                </span>
                <span className="flex items-center gap-3 text-xs">
                    {lastFired && (
                        <span className="text-text-tertiary">
                            last fired <TimeAgo date={lastFired} />
                        </span>
                    )}
                    {state && (
                        <Badge
                            active
                            size="xs"
                            title={state.title}
                            className={cn(
                                "pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1",
                                state.className,
                            )}>
                            {state.label}
                        </Badge>
                    )}
                </span>
            </header>

            {isLoading ? (
                <div className="grid grid-cols-2 gap-px px-4 py-3 sm:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-9 w-20" />
                    ))}
                </div>
            ) : (
                <div className="bg-card-lv3/60 grid grid-cols-2 gap-px sm:grid-cols-4">
                    <Stat
                        value={healthRow?.triggers ?? list.length}
                        label="triggers"
                    />
                    <Stat
                        value={healthRow?.implemented ?? 0}
                        label="implemented"
                        detail={
                            healthRow
                                ? `${Math.round(healthRow.rate * 100)}%`
                                : undefined
                        }
                        locked={!canSeeAnalytics}
                    />
                    <Stat
                        value={
                            <span className="inline-flex items-center gap-2">
                                <span className="inline-flex items-center gap-1">
                                    <ThumbsUpIcon className="text-success size-3.5" />
                                    {healthRow?.thumbsUp ?? 0}
                                </span>
                                <span className="inline-flex items-center gap-1">
                                    <ThumbsDownIcon className="text-danger size-3.5" />
                                    {healthRow?.thumbsDown ?? 0}
                                </span>
                            </span>
                        }
                        label="feedback"
                        locked={!canSeeAnalytics}
                    />
                    <Stat value={prCount} label="pull requests" />
                </div>
            )}

            {list.length > 0 && (
                <ul className="divide-card-lv3/60 border-card-lv3/60 divide-y border-t">
                    {list.slice(0, RECENT_LIMIT).map((item) => (
                        <li
                            key={item.id}
                            className="flex items-center gap-3 px-4 py-2 text-xs">
                            <a
                                href={item.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={item.prTitle}
                                className="text-text-secondary hover:text-primary-light flex shrink-0 items-center gap-1 font-mono tabular-nums">
                                <GitPullRequestIcon className="size-3" />#
                                {item.prNumber}
                            </a>
                            <span
                                title={item.oneSentenceSummary}
                                className="text-text-primary min-w-0 flex-1 truncate">
                                {item.oneSentenceSummary || item.prTitle}
                            </span>
                            <span
                                title={item.relevantFile}
                                className="text-text-tertiary hidden max-w-[11rem] truncate font-mono sm:inline">
                                {item.relevantFile}
                            </span>
                            <span className="text-text-tertiary shrink-0">
                                <TimeAgo date={item.createdAt} />
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <footer className="border-card-lv3/60 flex items-center justify-between gap-3 border-t px-4 py-2">
                <span className="text-text-tertiary text-xs">
                    {!isLoading && list.length === 0
                        ? "No suggestions from this rule yet."
                        : `${list.length} suggestion${list.length === 1 ? "" : "s"} in total`}
                    {!canSeeAnalytics && (
                        <>
                            {" · "}
                            <GateCtaLink
                                feature="cockpit"
                                plan={license?.subscriptionStatus}
                                metadata={{ surface: "rule_impact" }}
                                label="Unlock implementation and feedback"
                                size="xs"
                                variant="cancel"
                                className="inline-flex align-baseline"
                                buttonClassName="h-auto min-h-0 gap-1 p-0 [--button-foreground:var(--color-primary-light)] button-hover:underline"
                            />
                        </>
                    )}
                </span>
                {list.length > 0 && seeAll}
            </footer>
        </section>
    );
};
