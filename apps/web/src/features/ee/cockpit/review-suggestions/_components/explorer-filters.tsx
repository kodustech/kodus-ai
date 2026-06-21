"use client";

import { useRouter } from "next/navigation";
import { Card } from "@components/ui/card";

import type { ExplorerSearchParams } from "../page";

// Keep in sync with LabelType in
// libs/common/utils/codeManagement/labels.ts — suggestions are stored with
// any of these label values, and the cockpit feedback widgets link here with
// `?category=<label>`. Missing values (e.g. "bug") made those links land on a
// filter the dropdown couldn't represent, silently showing "Category: all".
const CATEGORIES = [
    "security",
    "potential_issues",
    "error_handling",
    "performance_and_optimization",
    "performance",
    "maintainability",
    "refactoring",
    "code_style",
    "documentation_and_comments",
    "kody_rules",
    "breaking_changes",
    "bug",
    "cross_file",
    "business_logic",
];

const SEVERITIES = ["critical", "high", "medium", "low"];

const STATUSES = [
    { value: "implemented", label: "Implemented" },
    { value: "partially_implemented", label: "Partially implemented" },
    { value: "not_implemented", label: "Not implemented" },
];

const selectClassName =
    "bg-card-lv2 border-card-lv3 text-text-secondary rounded-md border px-2.5 py-2 text-xs outline-none";

export const ExplorerFilters = ({
    params,
}: {
    params: ExplorerSearchParams;
}) => {
    const router = useRouter();

    const apply = (patch: Partial<ExplorerSearchParams>) => {
        const next = new URLSearchParams();
        const merged = { ...params, ...patch, page: undefined };
        for (const [key, value] of Object.entries(merged)) {
            if (value) next.set(key, value);
        }
        router.push(`/review-suggestions?${next.toString()}`);
    };

    return (
        <Card color="lv1" className="flex flex-row flex-wrap gap-2 p-3">
            {params.ruleId && (
                <button
                    type="button"
                    onClick={() =>
                        apply({ ruleId: undefined, ruleTitle: undefined })
                    }
                    className="border-primary-light text-primary-light bg-primary-light/10 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
                    <span className="opacity-70">rule:</span>
                    {params.ruleTitle ?? params.ruleId}
                    <span className="opacity-70">✕</span>
                </button>
            )}

            <select
                className={selectClassName}
                value={params.category ?? ""}
                onChange={(e) =>
                    apply({ category: e.target.value || undefined })
                }>
                <option value="">Category: all</option>
                {/* A category that arrived via the URL but isn't in the
                    canonical list still renders, so the active filter is
                    visible instead of falling back to "Category: all". */}
                {params.category && !CATEGORIES.includes(params.category) && (
                    <option value={params.category}>{params.category}</option>
                )}
                {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                        {c}
                    </option>
                ))}
            </select>

            <select
                className={selectClassName}
                value={params.severity ?? ""}
                onChange={(e) =>
                    apply({ severity: e.target.value || undefined })
                }>
                <option value="">Severity: all</option>
                {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                        {s}
                    </option>
                ))}
            </select>

            <select
                className={selectClassName}
                value={params.implementationStatus ?? ""}
                onChange={(e) =>
                    apply({ implementationStatus: e.target.value || undefined })
                }>
                <option value="">Status: all</option>
                {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                        {s.label}
                    </option>
                ))}
            </select>

            <input
                type="search"
                placeholder="Search suggestions, files…"
                defaultValue={params.search ?? ""}
                className="bg-card-lv2 border-card-lv3 text-text-secondary placeholder:text-text-tertiary min-w-56 flex-1 rounded-md border px-3 py-2 text-xs outline-none"
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        apply({
                            search:
                                (e.target as HTMLInputElement).value ||
                                undefined,
                        });
                    }
                }}
            />

            {(params.category ||
                params.severity ||
                params.implementationStatus ||
                params.repository ||
                params.search ||
                params.ruleId) && (
                <button
                    type="button"
                    onClick={() => router.push("/review-suggestions")}
                    className="text-text-tertiary hover:text-text-secondary px-2 text-xs font-semibold">
                    Clear all
                </button>
            )}
        </Card>
    );
};
