"use client";

import { useState } from "react";
import NextLink from "next/link";
import {
    baseVersionLabel,
    comparisonSideLabel,
} from "@services/runtime/model/base-version";
import type { RunExercisedFile } from "@services/runtime/contracts";
import { formatDurationMs } from "@services/runtime/format";
import type {
    CoverageMark,
    CoverageRow,
} from "@services/runtime/model/coverage";
import { hasLaneEvents } from "@services/runtime/model/replay-lanes";
import {
    checkLabel,
    OUTSIDE_DIFF_MARKER,
} from "@services/runtime/model/run-paths";
import {
    ChevronDownIcon,
    CircleAlertIcon,
    CircleCheckIcon,
    CircleDotIcon,
    CircleXIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { EvidenceLink } from "./evidence-link";
import { ReplayLanesView } from "./replay-lanes";
import { RichTextView } from "./rich-text";
import { StatusChip } from "./status-chip";
import { ViaNote } from "./via-note";

const MarkIcon = ({ mark }: { mark: CoverageMark }) => {
    const className = "size-4 shrink-0";
    switch (mark) {
        case "regression":
            return (
                <CircleXIcon
                    className={cn(className, "text-danger")}
                    aria-hidden
                />
            );
        case "intended":
        case "new":
            return (
                <CircleDotIcon
                    className={cn(className, "text-text-secondary")}
                    aria-hidden
                />
            );
        case "untested":
            return (
                <CircleAlertIcon
                    className={cn(className, "text-warning")}
                    aria-hidden
                />
            );
        default:
            return (
                <CircleCheckIcon
                    className={cn(className, "text-success")}
                    aria-hidden
                />
            );
    }
};

const PathEvidence = ({
    runId,
    row,
    id,
}: {
    runId: string;
    row: CoverageRow;
    id: string;
}) => {
    const baseLabel = row.path?.baseLabel ?? baseVersionLabel();
    const steps = row.path?.steps ?? [];
    const lanes = row.path?.lanes;
    const rounds = { base: 0, pr: 0 };
    return (
        <div id={id} className="flex flex-col gap-2">
            <ol className="bg-card-lv2 flex flex-col gap-1 rounded-xl p-3 font-mono text-xs">
                {steps.map((s) => {
                    rounds[s.side] += 1;
                    return (
                        <li
                            key={s.stepId}
                            className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="text-text-tertiary max-w-full min-w-0 break-words">
                                {comparisonSideLabel(s.side, baseLabel)} · round{" "}
                                {rounds[s.side]}
                            </span>
                            <span
                                className={cn(
                                    s.ok === false
                                        ? "text-danger"
                                        : "text-text-primary",
                                )}>
                                {s.observed}
                            </span>
                            {s.durationMs !== undefined && (
                                <span className="text-text-tertiary">
                                    {formatDurationMs(s.durationMs)}
                                </span>
                            )}
                            {s.finishedAt && (
                                <EvidenceLink
                                    runId={runId}
                                    stepId={s.stepId}
                                    side={s.side}>
                                    Raw response
                                    <span className="sr-only">
                                        {" "}
                                        of{" "}
                                        {comparisonSideLabel(s.side, baseLabel)}
                                        , attempt {rounds[s.side]}, {row.route}
                                    </span>
                                </EvidenceLink>
                            )}
                        </li>
                    );
                })}
                {row.path?.reason && (
                    <li className="text-text-tertiary pt-1 font-sans">
                        {row.path.reason}
                    </li>
                )}
            </ol>
            {lanes && hasLaneEvents(lanes) && (
                <ReplayLanesView
                    runId={runId}
                    lanes={lanes}
                    route={row.route}
                    baseLabel={baseLabel}
                    defaultOpen
                />
            )}
        </div>
    );
};

/** "What Kody tested": every path with a plain state; evidence one click away. */
export const RunCoverageList = ({
    runId,
    rows,
    live,
}: {
    runId: string;
    rows: CoverageRow[];
    live?: boolean;
}) => {
    const [open, setOpen] = useState<Set<string>>(new Set());
    if (rows.length === 0)
        return (
            <p className="text-text-secondary text-sm">
                {live
                    ? "Tested paths appear here as Kody runs them."
                    : "This Run tested no path."}
            </p>
        );
    const toggle = (key: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    return (
        <ul className="flex flex-col gap-2">
            {rows.map((row) => {
                const hasEvidence =
                    (row.path?.steps.length ?? 0) > 0 ||
                    hasLaneEvents(row.path?.lanes);
                const isOpen = open.has(row.key);
                const panelId = `coverage-${row.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                return (
                    <li
                        key={row.key}
                        className="bg-card-lv2/40 flex flex-col gap-3 rounded-xl px-4 py-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <MarkIcon mark={row.mark} />
                            <code className="text-text-primary font-mono text-sm">
                                {row.route}
                            </code>
                            {row.path && checkLabel(row.path.probeId) && (
                                <span className="text-text-secondary text-sm">
                                    {checkLabel(row.path.probeId)}
                                </span>
                            )}
                            {row.outsideDiff && (
                                <span className="text-text-tertiary text-xs">
                                    {OUTSIDE_DIFF_MARKER}
                                </span>
                            )}
                            {row.via && <ViaNote via={row.via} />}
                            <StatusChip tone={row.tone}>{row.label}</StatusChip>
                            <span className="text-text-secondary min-w-0 flex-1 text-sm">
                                <RichTextView text={row.detail} />
                            </span>
                            {row.action && (
                                <NextLink
                                    href={row.action.href}
                                    className="text-primary-light inline-flex min-h-11 items-center text-sm underline-offset-2 hover:underline">
                                    {row.action.label}
                                </NextLink>
                            )}
                            {hasEvidence && (
                                <button
                                    type="button"
                                    aria-expanded={isOpen}
                                    aria-controls={panelId}
                                    onClick={() => toggle(row.key)}
                                    className="text-text-secondary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none">
                                    {isOpen ? "Hide evidence" : "Show evidence"}
                                    <span className="sr-only">
                                        {" "}
                                        for {row.route}
                                    </span>
                                    <ChevronDownIcon
                                        className={cn(
                                            "size-4 transition-transform",
                                            isOpen && "rotate-180",
                                        )}
                                        aria-hidden
                                    />
                                </button>
                            )}
                        </div>
                        {hasEvidence && isOpen && (
                            <PathEvidence
                                runId={runId}
                                row={row}
                                id={panelId}
                            />
                        )}
                    </li>
                );
            })}
        </ul>
    );
};

/** Per changed file, how many of its changed lines ran on this PR during the probes. */
export const ExercisedFilesList = ({
    files,
}: {
    files: RunExercisedFile[];
}) => {
    if (files.length === 0) return null;
    return (
        <div className="flex flex-col gap-2">
            <span className="text-text-secondary text-xs font-medium">
                Changed lines that ran
            </span>
            <ul className="flex flex-col gap-1">
                {files.map((file) => (
                    <li
                        key={file.path}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                        <code className="text-text-primary font-mono break-all">
                            {file.path}
                        </code>
                        {file.status === "measured" &&
                        file.exercisedLines !== null ? (
                            <span className="text-text-secondary tabular-nums">
                                {file.exercisedLines} of {file.changedLines}{" "}
                                changed lines ran
                            </span>
                        ) : (
                            <>
                                <span className="text-text-secondary">
                                    not measured
                                </span>
                                {file.reason && (
                                    <span className="text-text-tertiary text-xs">
                                        {file.reason}
                                    </span>
                                )}
                            </>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
};
