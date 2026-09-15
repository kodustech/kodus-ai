"use client";

import { useMemo } from "react";
import { useAuth } from "src/core/providers/auth.provider";
import { apiProxyPath } from "src/core/utils/api-proxy";
import { cn } from "src/core/utils/components";
import { useFetch } from "src/core/utils/reactQuery";
import { safeArray } from "src/core/utils/safe-array";
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";
import type {
    KodyRuleHealthRow,
    KodyRuleHealthState,
} from "src/features/ee/cockpit/_services/analytics/review/fetch";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

export const HEALTH_WINDOW_DAYS = 30;

const toDateParam = (date: Date) => date.toISOString().slice(0, 10);

export const HEALTH: Record<
    KodyRuleHealthState,
    { label: string; className: string; title: string }
> = {
    healthy: {
        label: "Healthy",
        className:
            "bg-success/10 text-success ring-success/40 [--button-foreground:var(--color-success)]",
        title: "Triggers regularly and developers implement what it flags.",
    },
    noisy: {
        label: "Noisy",
        className:
            "bg-warning/10 text-warning ring-warning/40 [--button-foreground:var(--color-warning)]",
        title: "Triggers a lot, but almost nothing it flags gets implemented.",
    },
    ignored: {
        label: "Ignored",
        className:
            "bg-danger/10 text-danger ring-danger/40 [--button-foreground:var(--color-danger)]",
        title: "What it flags is being dismissed or voted down.",
    },
    stale: {
        label: "Stale",
        className:
            "bg-card-lv2 text-text-secondary ring-card-lv3 [--button-foreground:var(--color-text-secondary)]",
        title: "Hasn't triggered in this window.",
    },
    low_data: {
        label: "Low data",
        className:
            "bg-card-lv2 text-text-secondary ring-card-lv3 [--button-foreground:var(--color-text-secondary)]",
        title: "Too few triggers in this window to judge.",
    },
};

/** States worth a chip in the list; healthy / low-data stay quiet. */
export const ATTENTION_STATES: ReadonlySet<KodyRuleHealthState> = new Set([
    "noisy",
    "ignored",
    "stale",
]);

export type KodyRulesHealthIndex = {
    /** Whether this org's plan can see review analytics at all. */
    enabled: boolean;
    isLoading: boolean;
    /**
     * Rule uuid → health row for the last {@link HEALTH_WINDOW_DAYS} days.
     * `null` while there is nothing usable: plan-gated, still loading, failed,
     * or an empty warehouse (self-hosted without the analytics worker) — the
     * list hides its usage column in every one of those cases.
     */
    byRuleId: Map<string, KodyRuleHealthRow> | null;
};

/**
 * The Cockpit's per-rule health table (triggers, implementation rate,
 * feedback, state) indexed by rule. One org-wide request, cached by
 * react-query and shared by the list rows and the detail sheet.
 */
export const useKodyRulesHealth = (): KodyRulesHealthIndex => {
    const { organizationId } = useAuth();
    const { license } = useSubscriptionContext();
    const enabled = isCockpitTierAllowed(license) && !!organizationId;

    const range = useMemo(() => {
        const end = new Date();
        const start = new Date(end);
        start.setDate(start.getDate() - HEALTH_WINDOW_DAYS);
        return { startDate: toDateParam(start), endDate: toDateParam(end) };
    }, []);

    const query = useFetch<KodyRuleHealthRow[]>(
        apiProxyPath("/review-analytics/tables/kody-rules-health"),
        { params: { organizationId, ...range } },
        enabled,
    );

    const byRuleId = useMemo(() => {
        const rows = safeArray<KodyRuleHealthRow>(query.data);
        if (!enabled || rows.length === 0) return null;
        return new Map(rows.map((row) => [row.ruleId, row]));
    }, [enabled, query.data]);

    return { enabled, isLoading: enabled && query.isLoading, byRuleId };
};

export const RuleHealthChip = ({
    state,
    className,
}: {
    state: KodyRuleHealthState;
    className?: string;
}) => (
    <span
        title={HEALTH[state].title}
        className={cn(
            "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-medium ring-1 ring-inset",
            HEALTH[state].className,
            className,
        )}>
        {HEALTH[state].label}
    </span>
);
