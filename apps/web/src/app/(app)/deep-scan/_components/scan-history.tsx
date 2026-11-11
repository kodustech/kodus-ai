"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import type {
    SecurityScan,
    SecurityScanStatus,
} from "@services/security-scans/types";
import { formatDistanceToNow } from "date-fns";
import {
    CheckCircle2Icon,
    CircleDashedIcon,
    CircleSlashIcon,
    HistoryIcon,
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
 * then what it spent, covered and found. Opened from the header in a side
 * panel: the status banner already says what the latest one did.
 */
export const ScanHistoryButton = ({ scans }: { scans: SecurityScan[] }) => {
    const [open, setOpen] = useState(false);
    if (scans.length === 0) return null;

    return (
        <>
            <Button
                size="sm"
                variant="helper"
                leftIcon={<HistoryIcon />}
                onClick={() => setOpen(true)}>
                Scan history
                <span className="text-text-tertiary tabular-nums">
                    {scans.length}
                </span>
            </Button>

            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent className="w-full gap-0 py-0 sm:max-w-lg">
                    <SheetHeader className="border-card-lv3/60 border-b px-6 pt-5 pb-4">
                        <SheetTitle>Scan history</SheetTitle>
                        <SheetDescription>
                            The most recent deep scans of this team, newest first.
                        </SheetDescription>
                    </SheetHeader>

                    <ul className="divide-card-lv3/60 min-h-0 flex-1 divide-y overflow-y-auto">
                        {scans.map((scan) => (
                            <ScanRow key={scan.uuid} scan={scan} />
                        ))}
                    </ul>
                </SheetContent>
            </Sheet>
        </>
    );
};

const ScanRow = ({ scan }: { scan: SecurityScan }) => (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-6 py-3">
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
                className="text-text-tertiary text-xs"
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
            {formatDistanceToNow(new Date(scan.startedAt ?? scan.createdAt), {
                addSuffix: true,
            })}
        </span>
    </li>
);
