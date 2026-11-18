"use client";

import { useCallback, useMemo, useState } from "react";
import type { Tone } from "@services/runtime/labels";
import {
    baseVersionLabel,
    comparisonSideLabel,
} from "@services/runtime/model/base-version";
import {
    buildReplayLanes,
    formatOffset,
    LANE_KIND_LABEL,
    LANE_KINDS,
    type LaneCell,
    type LaneEventKind,
    type LaneEventView,
    type LaneSideView,
    type ReplayLanes,
} from "@services/runtime/model/replay-lanes";
import { cn } from "src/core/utils/components";

import { InlineDisclosure } from "./disclosure";
import { EvidenceLink } from "./evidence-link";
import { RichTextView } from "./rich-text";
import { TONE_DOT_CLASS } from "./status-chip";

// Main and this PR on one clock (EVIDENCE-CAPTURE-DESIGN "Product"). Every
// value is text the cell already redacted; artifacts open on the isolated
// evidence origin in a new tab (never inlined here, images and video
// included).

const KIND_TONE: Record<LaneEventKind, Tone> = {
    request: "info",
    log: "neutral",
    db: "alert",
    outbound: "warning",
    response: "success",
};

const EMPTY: Record<LaneEventKind, string> = {
    request: "No request recorded",
    log: "No log line",
    db: "No change",
    outbound: "No outbound call",
    response: "No answer",
};

/** Scroll a list (never the page) so its first-difference row is in view. */
const scrollIntoList = (el: HTMLElement | null) => {
    const list = el?.parentElement;
    if (!el || !list || list.scrollHeight <= list.clientHeight) return;
    list.scrollTop = Math.max(0, el.offsetTop - list.offsetTop - 8);
};

const Track = ({
    lane,
    spanMs,
    baseLabel,
}: {
    lane: LaneSideView;
    spanMs: number;
    baseLabel: string;
}) => (
    <div className="flex items-center gap-3">
        <span className="text-text-secondary w-16 shrink-0 text-xs break-words">
            {comparisonSideLabel(lane.side, baseLabel)}
        </span>
        <div
            className="bg-background relative h-6 min-w-0 flex-1 rounded-md"
            role="img"
            aria-label={`${comparisonSideLabel(lane.side, baseLabel)}: ${lane.track.length} events over ${formatOffset(spanMs).slice(1)}`}>
            {lane.track.map((e) => (
                <span
                    key={e.key}
                    title={`${formatOffset(e.at)} · ${LANE_KIND_LABEL[e.kind]} · ${e.label}`}
                    className={cn(
                        "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                        e.first
                            ? "bg-danger ring-danger/40 z-10 size-3 ring-4"
                            : cn("size-2", TONE_DOT_CLASS[KIND_TONE[e.kind]]),
                    )}
                    style={{ left: `${e.position}%` }}
                />
            ))}
        </div>
    </div>
);

const EventRow = ({ e }: { e: LaneEventView }) => (
    <li
        ref={e.first ? scrollIntoList : undefined}
        data-first-difference={e.first || undefined}
        className={cn(
            "flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-0.5 font-mono",
            e.first && "bg-danger/10 ring-danger/50 ring-1",
        )}>
        <span className="text-text-tertiary w-14 shrink-0 font-mono tabular-nums">
            {e.offset}
        </span>
        {e.service && (
            <span className="text-text-secondary shrink-0 font-mono">
                [{e.service}]
            </span>
        )}
        <span
            className={cn(
                "min-w-0 flex-1 font-mono break-words",
                e.first ? "text-danger" : "text-text-primary",
            )}>
            {e.label}
        </span>
        {e.first && (
            <span className="text-danger text-2xs font-sans font-medium whitespace-nowrap">
                First difference
            </span>
        )}
    </li>
);

const Cell = ({
    cell,
    kind,
    side,
    baseLabel,
}: {
    cell: LaneCell;
    kind: LaneEventKind;
    side: "base" | "pr";
    baseLabel: string;
}) => (
    <div className="min-w-0">
        <span className="text-text-tertiary text-2xs mb-1 block md:sr-only">
            {comparisonSideLabel(side, baseLabel)}
        </span>
        {!cell.captured ? (
            <p className="text-text-tertiary text-xs italic">
                not captured on this machine
            </p>
        ) : cell.events.length === 0 ? (
            <p className="text-text-tertiary text-xs">{EMPTY[kind]}</p>
        ) : (
            <ol className="relative flex max-h-44 flex-col gap-0.5 overflow-y-auto font-mono text-xs">
                {cell.events.map((e) => (
                    <EventRow key={e.key} e={e} />
                ))}
            </ol>
        )}
    </div>
);

const Artifacts = ({
    runId,
    lane,
    baseLabel,
}: {
    runId: string;
    lane: LaneSideView;
    baseLabel: string;
}) =>
    lane.artifacts.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-text-tertiary">
                {comparisonSideLabel(lane.side, baseLabel)}, attempt{" "}
                {lane.round}:
            </span>
            {lane.artifacts.map((a) => (
                <span key={a.type} className="inline-flex items-center gap-1">
                    <EvidenceLink
                        runId={runId}
                        stepId={lane.stepId}
                        side={lane.side}
                        type={a.type}>
                        {a.label}
                        <span className="sr-only">
                            {" "}
                            of {comparisonSideLabel(lane.side, baseLabel)},
                            attempt {lane.round}
                        </span>
                    </EvidenceLink>
                    <span className="text-text-tertiary">· {a.detail}</span>
                </span>
            ))}
        </div>
    );

/**
 * The replay of one probe round on main and on this PR, closed by default:
 * its summary says the takeaway (same request, both answers and when, what
 * else differed), so most readers never need to open it. Rows with nothing
 * on either side are left out; the takeaway says what they were.
 */
export const ReplayLanesView = ({
    runId,
    lanes,
    defaultOpen = false,
    route,
    baseLabel = baseVersionLabel(),
}: {
    runId: string;
    lanes: ReplayLanes;
    defaultOpen?: boolean;
    /** For the region's label: which path this replay belongs to. */
    route: string;
    baseLabel?: string;
}) => {
    const view = useMemo(
        () => buildReplayLanes(lanes, baseLabel),
        [lanes, baseLabel],
    );
    const fd = view.firstDifference;
    const fdAt = fd?.pr?.at ?? fd?.base?.at;
    const [root, setRoot] = useState<HTMLElement | null>(null);
    const jump = useCallback(() => {
        root?.querySelector<HTMLElement>(
            "[data-first-difference]",
        )?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [root]);
    const truncated = view.base.truncated || view.pr.truncated;
    const older = view.base.capturedNothing && view.pr.capturedNothing;
    const rows = view.rows.filter((row) => !row.empty);

    return (
        <section
            ref={setRoot}
            aria-label={`Replay of ${route} on ${baseLabel} and this PR`}>
            <InlineDisclosure
                label="Step-by-step replay"
                defaultOpen={defaultOpen}
                summary={<RichTextView text={view.takeaway} />}>
                <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <span className="text-text-secondary text-xs">
                            {baseLabel} and this PR on one clock
                        </span>
                        {fd && (
                            <button
                                type="button"
                                onClick={jump}
                                className="text-danger focus-visible:ring-ring rounded-sm text-xs font-medium underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:outline-none">
                                Go to the first difference:{" "}
                                {LANE_KIND_LABEL[fd.kind]}
                                {fdAt !== undefined &&
                                    ` at ${formatOffset(fdAt)}`}
                            </button>
                        )}
                    </div>
                    <Track
                        lane={view.base}
                        spanMs={view.spanMs}
                        baseLabel={baseLabel}
                    />
                    <Track
                        lane={view.pr}
                        spanMs={view.spanMs}
                        baseLabel={baseLabel}
                    />
                    <div className="text-text-tertiary text-2xs flex justify-between pl-[4.75rem] font-mono">
                        <span>+0 ms</span>
                        <span>{formatOffset(view.spanMs)}</span>
                    </div>
                    <ul
                        aria-label="Legend"
                        className="text-text-tertiary text-2xs flex flex-wrap gap-x-3 gap-y-1 pl-[4.75rem]">
                        {LANE_KINDS.map((k) => (
                            <li
                                key={k}
                                className="inline-flex items-center gap-1">
                                <span
                                    aria-hidden
                                    className={cn(
                                        "size-2 rounded-full",
                                        TONE_DOT_CLASS[KIND_TONE[k]],
                                    )}
                                />
                                {LANE_KIND_LABEL[k]}
                            </li>
                        ))}
                    </ul>
                </div>

                <div
                    role="table"
                    aria-label={`Each block on ${baseLabel} and on this PR`}
                    className="flex flex-col gap-2">
                    <div
                        role="row"
                        className="text-text-tertiary hidden gap-3 text-xs md:grid md:grid-cols-[7rem_1fr_1fr]">
                        <span role="columnheader">Block</span>
                        <span role="columnheader">
                            {baseLabel} · attempt {view.base.round}
                        </span>
                        <span role="columnheader">
                            this PR · attempt {view.pr.round}
                        </span>
                    </div>
                    {rows.map((row) => (
                        <div
                            key={row.kind}
                            role="row"
                            className="border-card-lv3 grid gap-2 border-t pt-2 md:grid-cols-[7rem_1fr_1fr] md:gap-3">
                            <span
                                role="rowheader"
                                className={cn(
                                    "text-xs font-medium",
                                    row.differs
                                        ? "text-danger"
                                        : "text-text-secondary",
                                )}>
                                {row.label}
                            </span>
                            <div role="cell" className="min-w-0">
                                <Cell
                                    cell={row.base}
                                    kind={row.kind}
                                    side="base"
                                    baseLabel={baseLabel}
                                />
                            </div>
                            <div role="cell" className="min-w-0">
                                <Cell
                                    cell={row.pr}
                                    kind={row.kind}
                                    side="pr"
                                    baseLabel={baseLabel}
                                />
                            </div>
                        </div>
                    ))}
                </div>

                {(view.base.artifacts.length > 0 ||
                    view.pr.artifacts.length > 0) && (
                    <div className="flex flex-col gap-1">
                        <span className="text-text-tertiary text-xs">
                            Raw evidence (opens on the evidence origin, in a new
                            tab)
                        </span>
                        <Artifacts
                            runId={runId}
                            lane={view.base}
                            baseLabel={baseLabel}
                        />
                        <Artifacts
                            runId={runId}
                            lane={view.pr}
                            baseLabel={baseLabel}
                        />
                    </div>
                )}
                {(truncated || older) && (
                    <p className="text-text-tertiary text-xs">
                        {older
                            ? "These machines captured only the answer: logs, database and outbound calls need a newer version of the Runtime on them."
                            : "Some events or log lines were cut to fit; the raw evidence has them all."}
                    </p>
                )}
            </InlineDisclosure>
        </section>
    );
};
