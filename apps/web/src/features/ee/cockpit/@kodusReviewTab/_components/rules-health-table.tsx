"use client";

import { useRouter } from "next/navigation";
import { DataTable } from "@components/ui/data-table";
import { cn } from "src/core/utils/components";

import { COCKPIT_REVIEW_PARAM } from "../../_constants";
import { useShallowParam } from "../../_helpers/use-shallow-param";
import type {
    KodyRuleHealthRow,
    KodyRuleHealthState,
} from "../../_services/analytics/review/fetch";
import { rulesColumns } from "./rules-columns";

type RuleFilter = KodyRuleHealthState | "all";

const FILTERS: Array<{ value: RuleFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "healthy", label: "Healthy" },
    { value: "noisy", label: "Noisy" },
    { value: "ignored", label: "Ignored" },
    { value: "stale", label: "Stale" },
];

const FILTER_VALUES = FILTERS.map((f) => f.value);

export const RulesHealthTable = ({ data }: { data: KodyRuleHealthRow[] }) => {
    const router = useRouter();
    const [filter, setFilter] = useShallowParam<RuleFilter>(
        COCKPIT_REVIEW_PARAM.rulesHealth,
        "all",
        FILTER_VALUES,
    );
    const [search, setSearch] = useShallowParam<string>(
        COCKPIT_REVIEW_PARAM.rulesQuery,
        "",
    );

    if (!data.length) {
        return (
            <div className="text-text-tertiary flex h-32 items-center justify-center text-sm">
                No Kody Rules triggered in this period.
            </div>
        );
    }

    const filtered =
        filter === "all" ? data : data.filter((row) => row.state === filter);

    return (
        <div>
            <div className="mb-3 flex flex-wrap gap-2">
                {FILTERS.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => setFilter(option.value)}
                        className={cn(
                            "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                            filter === option.value
                                ? "border-primary-light text-primary-light bg-primary-light/10"
                                : "border-card-lv3 bg-card-lv2 text-text-secondary",
                        )}>
                        {option.label}
                    </button>
                ))}
            </div>

            <DataTable
                columns={rulesColumns}
                data={filtered}
                searchable
                searchPlaceholder="Search rules…"
                searchValue={search}
                onSearchChange={setSearch}
                pageSize={10}
                getRowId={(row) => row.ruleId}
                onRowClick={(row) =>
                    router.push(
                        `/review-suggestions?ruleId=${encodeURIComponent(
                            row.ruleId,
                        )}&ruleTitle=${encodeURIComponent(row.title)}`,
                    )
                }
            />

            <p className="text-text-tertiary mt-3 text-[11px]">
                <strong>Healthy</strong> = good triggers + impl rate ·{" "}
                <strong>Noisy</strong> = high 👎 · <strong>Ignored</strong> =
                triggers a lot but nobody implements · <strong>Stale</strong> =
                no triggers in this period · <strong>Low data</strong> = not
                enough sample to judge
            </p>
        </div>
    );
};
