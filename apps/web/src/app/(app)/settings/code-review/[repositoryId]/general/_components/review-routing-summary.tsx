"use client";

import { Link } from "@components/ui/link";
import { ArrowUpRight } from "lucide-react";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";

import {
    modeLabel,
    useReviewRouting,
} from "../../routing/_components/use-review-routing";

export function ReviewRoutingSummary() {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const routing = useReviewRouting();
    const rows = routing.active
        ? [
              {
                  label: "No risk found",
                  mode: routing.effectiveMode(routing.noRisk),
              },
              {
                  label: "Risk found",
                  mode: routing.effectiveMode(routing.riskFound),
              },
          ]
        : [{ label: "All PRs", mode: routing.defaultMode }];
    const href = `/settings/code-review/${encodeURIComponent(repositoryId)}/routing${directoryId ? `?directoryId=${encodeURIComponent(directoryId)}` : ""}`;
    return (
        <div className="px-5 py-5 sm:px-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
                <h2 className="text-text-primary text-base font-semibold">
                    Review mode
                </h2>
                <Link
                    href={href}
                    className="text-text-secondary inline-flex items-center gap-1 text-sm">
                    Configure routing <ArrowUpRight className="size-3.5" />
                </Link>
            </div>
            <dl className="divide-card-lv3 divide-y text-sm">
                {rows.map((row) => (
                    <div
                        key={row.label}
                        className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
                        <dt className="text-text-secondary">{row.label}</dt>
                        <dd className="text-text-primary min-w-0 font-medium break-words">
                            {modeLabel(row.mode)}{" "}
                            <span className="text-text-secondary ml-3 font-normal">
                                {routing.modelFor(row.mode)}
                            </span>
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
