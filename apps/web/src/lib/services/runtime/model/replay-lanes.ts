import type {
    LaneBlock,
    LaneEvent,
    LaneEventKind,
    ReplayLane,
    ReplayLanes,
} from "@libs/runtime/run/replay-lanes";

import type { EvidenceType } from "../contracts";
import { baseVersionLabel } from "./base-version";
import { code, type RichText } from "./rich-text";

// Replay lanes on the Run page (EVIDENCE-CAPTURE-DESIGN "Product"): main and
// this PR on one clock, block by block (request → app logs → database →
// outbound → response), with the first place they part. Built from the
// verdict's `lanes` only: the screen shows the gate's decision, it never
// makes one, with one reading of its own: a request block that differs only
// in the status it carries (`GET /x → 404` against `GET /x → 200`) is the
// same request with a different answer, so the response is what differs. A
// block a cell did not capture says so; it is never "nothing".

export type { ReplayLane, ReplayLanes, LaneEvent, LaneEventKind };

/** The lane order of the contract (libs/runtime/run/replay-lanes.ts LANE_EVENT_KINDS). */
export const LANE_KINDS: readonly LaneEventKind[] = [
    "request",
    "log",
    "db",
    "outbound",
    "response",
];

export const LANE_KIND_LABEL: Record<LaneEventKind, string> = {
    request: "Request",
    log: "App logs",
    db: "Database",
    outbound: "Outbound",
    response: "Response",
};

/** The kind of one event, inside a sentence ("app log `database is locked`"). */
export const LANE_KIND_NOUN: Record<LaneEventKind, string> = {
    request: "request",
    log: "app log",
    db: "database change",
    outbound: "outbound call",
    response: "response",
};

const BLOCK_OF: Record<Exclude<LaneEventKind, "response">, LaneBlock> = {
    request: "requests",
    log: "logs",
    db: "db",
    outbound: "outbound",
};

export type LaneEventView = {
    /** Stable within one cell: its place in the side's list. */
    key: string;
    kind: LaneEventKind;
    at: number;
    /** "+12 ms". */
    offset: string;
    label: string;
    service?: string;
    /** Where it sits on the shared clock, 0–100. */
    position: number;
    /** This side's event at the first difference. */
    first: boolean;
};

export type LaneCell =
    { captured: false } | { captured: true; events: LaneEventView[] };

export type LaneBlockRow = {
    kind: LaneEventKind;
    label: string;
    base: LaneCell;
    pr: LaneCell;
    /** The first difference falls in this block. */
    differs: boolean;
    /** Nothing on either side (captured or not): the screen leaves the row out. */
    empty: boolean;
};

export type LaneArtifact = {
    type: EvidenceType;
    label: string;
    /** "12 KB · cut". */
    detail: string;
};

export type LaneSideView = {
    side: "base" | "pr";
    stepId: string;
    round: number;
    /** Every event of the side, on the shared clock (for the track). */
    track: LaneEventView[];
    artifacts: LaneArtifact[];
    truncated: boolean;
    /** No block but the response was captured: an older cell. */
    capturedNothing: boolean;
};

export type ReplayLanesView = {
    /** The clock's length: the longer side's window or last event. */
    spanMs: number;
    base: LaneSideView;
    pr: LaneSideView;
    rows: LaneBlockRow[];
    /** Absent: main and this PR match on every block both captured. */
    firstDifference?: {
        kind: LaneEventKind;
        base?: LaneEventView;
        pr?: LaneEventView;
    };
    /** One sentence: the request, both answers and when, and what else differed. */
    takeaway: RichText;
};

/** The plural noun of a block, inside the takeaway. */
const BLOCK_NOUN: Record<
    Exclude<LaneEventKind, "request" | "response">,
    string
> = {
    log: "app logs",
    db: "database",
    outbound: "outbound calls",
};

const OTHER_BLOCKS = ["log", "db", "outbound"] as const;

/** `GET /x → 404` → `GET /x`: what the request was, without what it got. */
const withoutStatus = (label: string) => label.replace(/\s*→\s*\S+$/, "");

/**
 * The request block parts only on the status it carries: the same request on
 * both sides, so the first difference is really the answer.
 */
export const requestOnlyStatusDiffers = (lanes: ReplayLanes): boolean => {
    if (lanes.firstDifference?.kind !== "request") return false;
    const requests = (lane: ReplayLane) =>
        lane.events
            .filter((e) => e.kind === "request")
            .map((e) => `${e.service ?? ""}\u0000${withoutStatus(e.label)}`);
    const a = requests(lanes.base);
    const b = requests(lanes.pr);
    return a.length === b.length && a.every((x, i) => x === b[i]);
};

/** Text that varies between two runs of the same code compares as equal (libs/runtime/run/replay-lanes.ts normalizeLaneLabel). */
const normalizeLaneLabel = (label: string) =>
    label
        .replace(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
            "#",
        )
        .replace(/\b[0-9a-f]{16,}\b/gi, "#")
        .replace(/\d+(\.\d+)?/g, "#");

const sameBlock = (a: LaneEventView[], b: LaneEventView[]) =>
    a.length === b.length &&
    a.every(
        (e, i) =>
            (e.service ?? "") === (b[i].service ?? "") &&
            normalizeLaneLabel(e.label) === normalizeLaneLabel(b[i].label),
    );

/** `a`, `a and b`, `a, b and c`. */
const list = (items: readonly string[]) =>
    items.length <= 1
        ? (items[0] ?? "")
        : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "404" from `status 404`; any other answer as the lane says it. */
const answerOf = (e: LaneEventView | undefined) =>
    e ? e.label.replace(/^status /, "") : undefined;

const takeawayOf = (
    view: Omit<ReplayLanesView, "takeaway">,
    baseLabel: string,
): RichText => {
    const fd = view.firstDifference;
    const parts: RichText[] = [];
    const firstOf = (side: LaneEventView[] | undefined) => side?.[0];

    // The request: the probe sent the same one to both; the app's own view of it may differ.
    if (fd?.kind === "request") {
        parts.push([
            `${baseLabel} and this PR handled different requests`,
            ...(fd.pr
                ? [" (this PR: ", code(fd.pr.label), ")"]
                : fd.base
                  ? [` (${baseLabel}: `, code(fd.base.label), ")"]
                  : []),
        ]);
    } else parts.push(["Same request"]);

    // The answers, with when each side gave it.
    const rowOf = (kind: LaneEventKind) =>
        view.rows.find((r) => r.kind === kind);
    const response = rowOf("response");
    const events = (cell: LaneCell | undefined) =>
        cell?.captured ? cell.events : [];
    const a = firstOf(events(response?.base));
    const b = firstOf(events(response?.pr));
    if (a && b && a.label === b.label)
        parts.push([
            `both answered ${answerOf(a)}`,
            fd?.kind === "response" ? " with a different body" : "",
        ]);
    else
        parts.push([
            a
                ? `${baseLabel} answered ${answerOf(a)} at ${a.offset}`
                : `${baseLabel} gave no answer`,
            ", ",
            b
                ? `this PR ${answerOf(b)} at ${b.offset}`
                : "this PR gave no answer",
        ]);

    // App logs, database and outbound calls: where they parted first, what else differed, what was not captured.
    const same: string[] = [];
    const differed: string[] = [];
    const notCaptured: string[] = [];
    for (const kind of OTHER_BLOCKS) {
        const row = rowOf(kind);
        if (!row) continue;
        if (!row.base.captured || !row.pr.captured) {
            notCaptured.push(BLOCK_NOUN[kind]);
            continue;
        }
        if (fd?.kind === kind) {
            const event = fd.pr ?? fd.base;
            const who = fd.pr ? "this PR" : baseLabel;
            parts.push([
                `${BLOCK_NOUN[kind]} differed first`,
                ...(event
                    ? [` (${who}: `, code(event.label), ` at ${event.offset})`]
                    : []),
            ]);
        } else if (sameBlock(row.base.events, row.pr.events))
            same.push(BLOCK_NOUN[kind]);
        else differed.push(BLOCK_NOUN[kind]);
    }
    if (differed.length) parts.push([`${list(differed)} also differed`]);
    if (same.length) parts.push([`${list(same)} did not differ`]);
    if (notCaptured.length) parts.push([`${list(notCaptured)} not captured`]);

    const out: RichText = [];
    parts.forEach((p, i) => {
        if (i > 0) out.push("; ");
        out.push(...p);
    });
    out.push(".");
    return out;
};

/** "+12 ms", "+1.2 s". */
export const formatOffset = (ms: number): string => {
    const v = Math.max(0, ms);
    if (v < 1000) return `+${Math.round(v)} ms`;
    const s = v / 1000;
    return `+${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)} s`;
};

const kib = (bytes: number) =>
    bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${Math.round(bytes / 1024)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** What a lane artifact is, in the screen's words; every one opens in a new tab on the evidence origin. */
export const laneArtifactLabel = (type: string): string => {
    if (type.startsWith("screenshot-"))
        return `Screenshot ${Number(type.slice(11)) + 1}`;
    if (type.startsWith("pixeldiff-"))
        return `Pixel diff ${Number(type.slice(10)) + 1}`;
    switch (type) {
        case "logs":
            return "App logs";
        case "db":
            return "Database changes";
        case "cast":
            return "Terminal recording";
        case "video":
            return "Video";
        case "trace":
            return "Browser trace";
        case "har":
            return "Network log (HAR)";
        default:
            return type;
    }
};

const sameEvent = (a: LaneEvent | undefined, b: LaneEvent) =>
    !!a &&
    a.kind === b.kind &&
    a.at === b.at &&
    a.label === b.label &&
    (a.service ?? "") === (b.service ?? "");

/** The clock both lanes share: the longer side's window, or its last event. */
export const laneSpanMs = (lanes: Pick<ReplayLanes, "base" | "pr">): number =>
    Math.max(
        1,
        ...[lanes.base, lanes.pr].flatMap((l) => [
            l.windowMs ?? 0,
            ...l.events.map((e) => e.at),
        ]),
    );

const capturedBlock = (lane: ReplayLane, kind: LaneEventKind) =>
    kind === "response" || lane.captured?.[BLOCK_OF[kind]] === true;

export const buildReplayLanes = (
    lanes: ReplayLanes,
    baseLabel = baseVersionLabel(),
): ReplayLanesView => {
    const spanMs = laneSpanMs(lanes);
    // Only the answer differs: mark the responses, not the requests that carry it.
    const fd = requestOnlyStatusDiffers(lanes)
        ? {
              kind: "response" as const,
              base: lanes.base.events.find((e) => e.kind === "response"),
              pr: lanes.pr.events.find((e) => e.kind === "response"),
          }
        : lanes.firstDifference;
    const viewsOf = (lane: ReplayLane): LaneEventView[] => {
        const target = lane.side === "base" ? fd?.base : fd?.pr;
        let marked = false;
        return lane.events.map((e, i) => {
            // Only one event per side is the first difference, even when two are equal.
            const first = !marked && !!target && sameEvent(target, e);
            if (first) marked = true;
            return {
                key: `${lane.side}-${i}`,
                kind: e.kind,
                at: e.at,
                offset: formatOffset(e.at),
                label: e.label,
                ...(e.service ? { service: e.service } : {}),
                position: Math.min(100, Math.max(0, (e.at / spanMs) * 100)),
                first,
            };
        });
    };
    const base = viewsOf(lanes.base);
    const pr = viewsOf(lanes.pr);
    const cellOf = (
        lane: ReplayLane,
        views: LaneEventView[],
        kind: LaneEventKind,
    ): LaneCell =>
        capturedBlock(lane, kind)
            ? { captured: true, events: views.filter((v) => v.kind === kind) }
            : { captured: false };
    const sideOf = (
        lane: ReplayLane,
        views: LaneEventView[],
    ): LaneSideView => ({
        side: lane.side,
        stepId: lane.stepId,
        round: lane.round,
        track: views,
        artifacts: (lane.artifacts ?? []).map((a) => ({
            type: a.type,
            label: laneArtifactLabel(a.type),
            detail: `${kib(a.bytes)}${a.truncated ? " · cut" : ""}`,
        })),
        truncated: lane.truncated,
        capturedNothing: !Object.values(lane.captured ?? {}).some(Boolean),
    });
    const hasEvents = (cell: LaneCell) =>
        cell.captured && cell.events.length > 0;
    const view: Omit<ReplayLanesView, "takeaway"> = {
        spanMs,
        base: sideOf(lanes.base, base),
        pr: sideOf(lanes.pr, pr),
        rows: LANE_KINDS.map((kind) => {
            const row = {
                kind,
                label: LANE_KIND_LABEL[kind],
                base: cellOf(lanes.base, base, kind),
                pr: cellOf(lanes.pr, pr, kind),
                differs: fd?.kind === kind,
            };
            return {
                ...row,
                empty: !hasEvents(row.base) && !hasEvents(row.pr),
            };
        }),
        ...(fd
            ? {
                  firstDifference: {
                      kind: fd.kind,
                      ...optional(
                          "base",
                          base.find((v) => v.first),
                      ),
                      ...optional(
                          "pr",
                          pr.find((v) => v.first),
                      ),
                  },
              }
            : {}),
    };
    return { ...view, takeaway: takeawayOf(view, baseLabel) };
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** The lanes are worth drawing: at least one side has an event. */
export const hasLaneEvents = (lanes: ReplayLanes | undefined): boolean =>
    !!lanes &&
    (lanes.base?.events?.length ?? 0) + (lanes.pr?.events?.length ?? 0) > 0;
