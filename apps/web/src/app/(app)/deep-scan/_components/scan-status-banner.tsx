"use client";

import type { PropsWithChildren, ReactNode } from "react";
import {
    isSecurityScanActive,
    type SecurityScan,
} from "@services/security-scans/types";
import { formatDistanceToNow } from "date-fns";
import {
    ShieldAlertIcon,
    ShieldCheckIcon,
    ShieldIcon,
    ShieldXIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    formatScanOutcome,
    formatScanSpend,
} from "../../issues/_components/security-scan/format";

const ago = (iso?: string) =>
    iso ? formatDistanceToNow(new Date(iso), { addSuffix: true }) : "";

/**
 * Where the scanning stands, in one line: the scan running now with its
 * progress, or the last one and what it found. Above everything else, so a
 * team sees at a glance whether its repositories were looked at recently.
 */
export const ScanStatusBanner = ({ scans }: { scans: SecurityScan[] }) => {
    const running = scans.find(isSecurityScanActive);
    const last = running ?? scans[0];

    if (!last) {
        return (
            <Banner tone="neutral" icon={<ShieldIcon />}>
                <p className="text-text-primary text-sm font-medium">
                    No repository scanned yet
                </p>
                <p className="text-text-secondary text-sm">
                    Run a deep scan to find vulnerabilities in a
                    repository&apos;s default branch. Findings are listed below
                    as the scan stores them.
                </p>
            </Banner>
        );
    }

    if (running) {
        const total = running.coverage?.unitsTotal ?? 0;
        const done =
            (running.coverage?.unitsDone ?? 0) +
            (running.coverage?.unitsFailed ?? 0);
        return (
            <Banner tone="info" icon={<ShieldIcon />}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <p className="text-text-primary text-sm font-medium">
                        {/* Queued again between two jobs: already started. */}
                        {running.status === "queued" && !running.startedAt
                            ? `Starting a scan of ${running.repository.fullName}`
                            : `Scanning ${running.repository.fullName}`}
                    </p>
                    <span className="text-text-secondary text-xs">
                        {[
                            total
                                ? `${done} of ${total} areas`
                                : "mapping the repository",
                            formatScanSpend(running),
                            formatScanOutcome(running.outcome),
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </span>
                </div>
                <ScanProgressBar
                    percent={total ? Math.round((done / total) * 100) : 0}
                />
            </Banner>
        );
    }

    const tone =
        last.status === "failed"
            ? "danger"
            : last.status === "stopped_by_budget"
              ? "warning"
              : "success";
    const icon =
        tone === "danger" ? (
            <ShieldXIcon />
        ) : tone === "warning" ? (
            <ShieldAlertIcon />
        ) : (
            <ShieldCheckIcon />
        );
    const headline =
        last.status === "failed"
            ? `The last scan of ${last.repository.fullName} failed`
            : last.status === "stopped_by_budget"
              ? `The last scan of ${last.repository.fullName} stopped at its spend limit`
              : `${last.repository.fullName} was scanned ${ago(last.finishedAt ?? last.updatedAt)}`;
    const detail =
        last.status === "failed"
            ? last.error
            : [
                  formatScanOutcome(last.outcome),
                  formatScanSpend(last),
                  last.status === "stopped_by_budget" &&
                  last.coverage?.unitsSkippedByBudget
                      ? `${last.coverage.unitsSkippedByBudget} areas not reached; run it again to continue`
                      : "",
              ]
                  .filter(Boolean)
                  .join(" · ");

    return (
        <Banner tone={tone} icon={icon}>
            <p className="text-text-primary text-sm font-medium">{headline}</p>
            {detail && (
                <p className="text-text-secondary line-clamp-1 text-sm">
                    {detail}
                </p>
            )}
        </Banner>
    );
};

const toneClassnames = {
    neutral: "border-card-lv3/60 [--tone:var(--color-text-secondary)]",
    info: "border-info/30 bg-info/5 [--tone:var(--color-info)]",
    success: "border-success/30 bg-success/5 [--tone:var(--color-success)]",
    warning: "border-warning/30 bg-warning/5 [--tone:var(--color-warning)]",
    danger: "border-danger/30 bg-danger/5 [--tone:var(--color-danger)]",
} as const;

const Banner = ({
    tone,
    icon,
    children,
}: PropsWithChildren<{
    tone: keyof typeof toneClassnames;
    icon: ReactNode;
}>) => (
    <div
        className={cn(
            "bg-card-lv1 flex items-start gap-3 rounded-xl border px-4 py-3.5",
            toneClassnames[tone],
        )}>
        <span className="mt-0.5 shrink-0 text-(--tone) [&_svg]:size-5">
            {icon}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
    </div>
);

/** Thin and calm: the scan runs for minutes, the bar only says how far. */
const ScanProgressBar = ({ percent }: { percent: number }) => (
    <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="bg-card-lv3 mt-2.5 h-1 w-full max-w-md overflow-hidden rounded-full">
        <div
            className="bg-info h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.max(percent, 2)}%` }}
        />
    </div>
);
