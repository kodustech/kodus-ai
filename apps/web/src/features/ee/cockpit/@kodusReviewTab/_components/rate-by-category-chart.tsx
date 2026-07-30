"use client";

import { useRouter } from "next/navigation";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type { ImplementationRateByCategoryRow } from "../../_services/analytics/review/fetch";

/**
 * Horizontal "sent vs implemented" bars. Plain divs instead of a chart
 * lib: per-row layout with labels + click-to-drill reads better as DOM.
 */
export const RateByCategoryChart = ({
    data,
}: {
    data: ImplementationRateByCategoryRow[];
}) => {
    const router = useRouter();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const maxSent = Math.max(...data.map((r) => r.sent));

    return (
        <div className="flex flex-col gap-1.5">
            {data.map((row) => (
                <button
                    key={row.category}
                    type="button"
                    onClick={() =>
                        router.push(
                            `/review-suggestions?category=${encodeURIComponent(row.category)}`,
                        )
                    }
                    className="hover:bg-card-lv3 group flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors">
                    <span className="text-text-secondary group-hover:text-primary-light flex w-36 shrink-0 items-center gap-1 truncate text-xs transition-colors">
                        {row.category}
                        <span className="opacity-0 transition-opacity group-hover:opacity-100">
                            →
                        </span>
                    </span>
                    <span className="bg-card-lv3/50 relative h-3.5 flex-1 overflow-hidden rounded-sm">
                        <span
                            className="bg-card-lv3 absolute inset-y-0 left-0 rounded-sm"
                            style={{
                                width: `${(row.sent / maxSent) * 100}%`,
                            }}
                        />
                        <span
                            className="absolute inset-y-0 left-0 rounded-sm bg-[#6a57a4]"
                            style={{
                                width: `${(row.implemented / maxSent) * 100}%`,
                            }}
                        />
                    </span>
                    <span className="text-text-tertiary w-32 shrink-0 text-right font-mono text-xs whitespace-nowrap">
                        {row.implemented}/{row.sent} ·{" "}
                        {Math.round(row.rate * 100)}%
                    </span>
                </button>
            ))}

            <div className="text-text-tertiary mt-2 flex gap-4 px-2 text-[11px]">
                <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-xs bg-[#6a57a4]" />
                    Implemented
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="bg-card-lv3 size-2 rounded-xs" />
                    Sent
                </span>
            </div>
        </div>
    );
};
