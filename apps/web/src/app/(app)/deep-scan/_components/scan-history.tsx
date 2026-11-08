"use client";

import type { ReactNode } from "react";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import type {
    SecurityScan,
    SecurityScanStatus,
} from "@services/security-scans/types";
import { formatDistanceToNow } from "date-fns";
import {
    CheckCircle2Icon,
    CircleDashedIcon,
    CircleSlashIcon,
    LoaderCircleIcon,
    XCircleIcon,
} from "lucide-react";

import {
    formatScanCoverage,
    formatScanOutcome,
    formatScanSpend,
    SCAN_STATUS_LABEL,
} from "../../issues/_components/security-scan/format";

const STATUS_ICON: Record<SecurityScanStatus, ReactNode> = {
    queued: <CircleDashedIcon className="text-info" />,
    running: <LoaderCircleIcon className="text-info animate-spin" />,
    completed: <CheckCircle2Icon className="text-success" />,
    stopped_by_budget: <CircleSlashIcon className="text-warning" />,
    failed: <XCircleIcon className="text-danger" />,
};

/**
 * Every scan, newest first, one line each: what was scanned and how it ended,
 * then what it spent, covered and found. Folded by default: the status banner
 * already says what the latest one did.
 */
export const ScanHistory = ({ scans }: { scans: SecurityScan[] }) => {
    if (scans.length === 0) return null;

    return (
        <Collapsible className="border-card-lv3/60 bg-card-lv1 shrink-0 rounded-xl border">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm">
                    <span className="font-medium">Scan history</span>
                    <span className="text-text-tertiary text-xs tabular-nums">
                        {scans.length}
                    </span>
                    <CollapsibleIndicator className="ml-auto" />
                </button>
            </CollapsibleTrigger>

            <CollapsibleContent className="pb-0">
                <ul className="divide-card-lv3/60 border-card-lv3/60 max-h-72 divide-y overflow-y-auto border-t">
                    {scans.map((scan) => (
                        <li
                            key={scan.uuid}
                            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2.5">
                            <span
                                className="mt-0.5 [&_svg]:size-4"
                                aria-label={SCAN_STATUS_LABEL[scan.status]}>
                                {STATUS_ICON[scan.status]}
                            </span>
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-text-primary truncate text-sm">
                                    {scan.repository.fullName}
                                    <span className="text-text-tertiary">
                                        {" "}
                                        · {SCAN_STATUS_LABEL[scan.status]}
                                    </span>
                                </span>
                                <span
                                    className="text-text-tertiary truncate text-xs"
                                    title={scan.error ?? undefined}>
                                    {scan.status === "failed" && scan.error
                                        ? scan.error
                                        : [
                                              formatScanSpend(scan),
                                              formatScanCoverage(scan.coverage),
                                              formatScanOutcome(scan.outcome),
                                          ]
                                              .filter(Boolean)
                                              .join(" · ")}
                                </span>
                            </span>
                            <span className="text-text-tertiary text-xs whitespace-nowrap">
                                {formatDistanceToNow(
                                    new Date(scan.startedAt ?? scan.createdAt),
                                    { addSuffix: true },
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            </CollapsibleContent>
        </Collapsible>
    );
};
