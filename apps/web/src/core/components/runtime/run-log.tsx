"use client";

import { useId, useMemo, useState } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import { formatDurationMs, formatUtcClock } from "@services/runtime/format";
import {
    filterRunLog,
    groupMark,
    initiallyOpen,
    runLogText,
    type RunLogGroup,
    type RunLogGroupId,
    type RunLogLine,
    type RunLogStatus,
    type RunLogTone,
} from "@services/runtime/model/run-log";
import {
    ChevronRightIcon,
    CopyIcon,
    DownloadIcon,
    SearchIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { EvidenceLink } from "./evidence-link";

// A terminal panel: the page ground (Void) sunk into the section's card, the
// darkest tone of the system, with the status hues for marks and results.
// Every text colour here measures at least 4.5:1 on Void.

const TONE: Record<RunLogTone, string> = {
    default: "text-text-primary",
    ok: "text-success",
    fail: "text-danger",
    warn: "text-alert",
    muted: "text-text-secondary",
};

const MARK_TONE: Record<RunLogStatus, string> = {
    ok: "text-success",
    warn: "text-alert",
    failed: "text-danger",
    running: "text-info",
    pending: "text-text-secondary",
};

const FOCUS =
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-3";

const STATUS_WORD: Record<RunLogStatus, string> = {
    ok: "done",
    warn: "needs a look",
    failed: "failed",
    running: "running",
    pending: "not started",
};

const download = (filename: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
    URL.revokeObjectURL(url);
};

const Line = ({
    line,
    runId,
    timestamps,
}: {
    line: RunLogLine;
    runId: string;
    timestamps: boolean;
}) => (
    <li className="flex flex-wrap items-baseline gap-x-2 py-0.5 pr-3 pl-9">
        {timestamps &&
            (line.at ? (
                <time
                    dateTime={line.at}
                    className="text-text-secondary w-16 shrink-0 tabular-nums">
                    {formatUtcClock(line.at)}
                </time>
            ) : (
                <span aria-hidden className="w-16 shrink-0" />
            ))}
        {line.side && (
            <span className="text-text-secondary max-w-full min-w-0 break-words">
                {line.side}
            </span>
        )}
        <span className="text-text-primary min-w-0 break-words">
            {line.command !== undefined ? (
                <>
                    <span aria-hidden className="text-text-secondary">
                        ${" "}
                    </span>
                    <span className="sr-only">Command: </span>
                    {line.command}
                </>
            ) : (
                line.text
            )}
        </span>
        {line.result && (
            <span className={TONE[line.result.tone]}>
                <span aria-hidden>→ </span>
                {line.result.text}
            </span>
        )}
        {line.durationMs !== undefined && (
            <span className="text-text-secondary">
                · {formatDurationMs(line.durationMs)}
            </span>
        )}
        {line.evidence && (
            <span className="ml-auto">
                <EvidenceLink
                    runId={runId}
                    stepId={line.evidence.stepId}
                    side={line.evidence.side}>
                    {line.evidence.label ?? "View details"}
                    <span className="sr-only"> of {line.text}</span>
                </EvidenceLink>
            </span>
        )}
    </li>
);

const Group = ({
    group,
    open,
    onToggle,
    runId,
    timestamps,
}: {
    group: RunLogGroup;
    open: boolean;
    onToggle: () => void;
    runId: string;
    timestamps: boolean;
}) => {
    const bodyId = useId();
    return (
        <li>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={onToggle}
                className={cn(
                    "hover:bg-card-lv1 flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left",
                    FOCUS,
                )}>
                <span
                    aria-hidden
                    className={cn("w-3 text-center", MARK_TONE[group.status])}>
                    {groupMark(group.status)}
                </span>
                <ChevronRightIcon
                    aria-hidden
                    className={cn(
                        "text-text-secondary size-3.5 transition-transform",
                        open && "rotate-90",
                    )}
                />
                <span className="text-text-primary">
                    {group.title}
                    {group.note && (
                        <span
                            className={cn(
                                group.status === "failed"
                                    ? "text-danger"
                                    : "text-text-secondary",
                            )}>
                            {" "}
                            · {group.note}
                        </span>
                    )}
                    <span className="sr-only">
                        , {STATUS_WORD[group.status]}
                    </span>
                </span>
                <span className="text-text-secondary ml-auto tabular-nums">
                    {group.durationMs !== undefined
                        ? formatDurationMs(group.durationMs)
                        : ""}
                </span>
            </button>
            {open && (
                <ol id={bodyId} className="pb-2">
                    {group.lines.map((line) => (
                        <Line
                            key={line.id}
                            line={line}
                            runId={runId}
                            timestamps={timestamps}
                        />
                    ))}
                </ol>
            )}
        </li>
    );
};

/** The Run log: grouped by phase, searchable, copyable; every step keeps its evidence. */
export const RunLogView = ({
    runId,
    groups,
    note,
}: {
    runId: string;
    groups: RunLogGroup[];
    /** Why the log is short (the live view failed, the stream expired). */
    note?: string;
}) => {
    const [query, setQuery] = useState("");
    const [onlyFailures, setOnlyFailures] = useState(false);
    const [timestamps, setTimestamps] = useState(true);
    const [toggled, setToggled] = useState<Set<RunLogGroupId>>(new Set());
    const defaults = useMemo(() => initiallyOpen(groups), [groups]);
    const filtering = query.trim() !== "" || onlyFailures;
    const shown = useMemo(
        () => filterRunLog(groups, { query, onlyFailures }),
        [groups, query, onlyFailures],
    );
    // A toggle flips the default; while filtering, the default is open.
    const isOpen = (id: RunLogGroupId) =>
        (filtering || defaults.has(id)) !== toggled.has(id);
    const toggle = (id: RunLogGroupId) =>
        setToggled((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(
                runLogText(shown, { timestamps }),
            );
            toast({ variant: "success", title: "Run log copied" });
        } catch {
            toast({
                variant: "danger",
                title: "Couldn't copy",
                description: "Download the log instead.",
            });
        }
    };

    const control = cn(
        "bg-card-lv2 text-text-secondary inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm hover:brightness-120",
        FOCUS,
    );

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <label className="bg-card-lv2 ring-card-lv3 focus-within:ring-ring flex min-h-11 min-w-56 flex-1 items-center gap-2 rounded-xl px-4 ring-1 focus-within:ring-3">
                    <SearchIcon
                        aria-hidden
                        className="text-text-secondary size-4"
                    />
                    <span className="sr-only">Search the log</span>
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search the log"
                        className="text-text-primary placeholder:text-text-secondary w-full bg-transparent text-sm focus:outline-none"
                    />
                </label>
                <label className={control}>
                    <input
                        type="checkbox"
                        checked={timestamps}
                        onChange={(e) => setTimestamps(e.target.checked)}
                        className={cn("accent-primary-light size-4", FOCUS)}
                    />
                    Timestamps (UTC)
                </label>
                <label className={control}>
                    <input
                        type="checkbox"
                        checked={onlyFailures}
                        onChange={(e) => setOnlyFailures(e.target.checked)}
                        className={cn("accent-primary-light size-4", FOCUS)}
                    />
                    Needs attention
                </label>
                <button type="button" className={control} onClick={copy}>
                    <CopyIcon aria-hidden className="size-4" />
                    Copy
                </button>
                <button
                    type="button"
                    className={control}
                    onClick={() =>
                        download(
                            `kody-runtime-${runId}.log`,
                            runLogText(groups, { timestamps: true }),
                        )
                    }>
                    <DownloadIcon aria-hidden className="size-4" />
                    Download raw
                </button>
            </div>
            {note && <p className="text-text-secondary text-sm">{note}</p>}
            <div className="bg-background text-review overflow-hidden rounded-xl py-1 font-mono leading-6">
                {shown.length === 0 ? (
                    <p
                        className="text-text-secondary px-3 py-3 font-sans text-sm"
                        role="status">
                        {onlyFailures && !query.trim()
                            ? "No recorded issues match this filter."
                            : "No line matches."}
                    </p>
                ) : (
                    <ol aria-label="Run log">
                        {shown.map((g) => (
                            <Group
                                key={g.id}
                                group={g}
                                open={isOpen(g.id)}
                                onToggle={() => toggle(g.id)}
                                runId={runId}
                                timestamps={timestamps}
                            />
                        ))}
                    </ol>
                )}
            </div>
        </div>
    );
};
