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
        <div className="px-5 py-4 sm:px-6">
            <div className="mb-3 flex items-center justify-between gap-4">
                <h2 className="text-text-primary text-sm font-medium">
                    Review mode
                </h2>
                <Link
                    href={href}
                    className="text-text-secondary inline-flex items-center gap-1 text-xs">
                    Configure routing <ArrowUpRight className="size-3.5" />
                </Link>
            </div>
            <dl className="space-y-2 text-xs">
                {rows.map((row) => (
                    <div
                        key={row.label}
                        className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                        <dt className="text-text-secondary">{row.label}</dt>
                        <dd className="text-text-primary">
                            {modeLabel(row.mode)}{" "}
                            <span className="text-text-secondary ml-2">
                                {routing.modelFor(row.mode)}
                            </span>
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
