import {
    RUN_STREAM_EVENT_TYPES,
    type CheckConclusion,
    type ProbeVerdict,
    type RunState,
    type RunStreamEvent,
    type RunStreamPage,
    type VerdictState,
} from "./contracts";
import { isRunState, isTerminalRunState } from "./labels";

// The Run stream (ADR-047): an ordered log read by offset, Durable Streams
// style. The live view long-polls from the last `nextOffset`; an error keeps
// that offset and retries, so a reconnect resumes without losing or repeating
// events.

export type RunStepView = {
    stepId: string;
    side?: string;
    kind?: string;
    probeId?: string;
    label?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    exitCode?: number;
    status?: number;
    transport?: string;
    verdict?: string;
    /** The hub's outcome: ok, timeout, refused, transport_lost, security_violation. */
    outcome?: string;
    vmHealth?: string;
};

/** The counts a phase event carries (entry points, probes, explored commands…). */
export type RunPhaseView = {
    phase: string;
    at: string;
    counts?: Record<string, number>;
};

export type RunStreamView = {
    states: Array<{ state: RunState; at: string; reason?: string }>;
    phases: RunPhaseView[];
    steps: RunStepView[];
    verdict?: {
        at: string;
        verdictState?: VerdictState;
        check?: { conclusion: CheckConclusion; title: string };
        findings?: ProbeVerdict[];
        /** Why the check stays neutral: decideRunVerdict's own fixed phrases. */
        forcedNeutral?: string[];
        /** Entry points left without a verdict. */
        uncovered?: string[];
        /** How many findings the PR intends, and probes refused before they ran. */
        intended?: number;
        rejectedProbes?: number;
        /** Why those probes were refused: the plan schema's own validation messages, never model text. */
        rejectedReasons?: string[];
    };
    published: Array<{ at: string; kind?: string; url?: string }>;
};

export const EMPTY_RUN_STREAM_VIEW: RunStreamView = {
    states: [],
    phases: [],
    steps: [],
    published: [],
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
const strings = (v: unknown) =>
    Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && !!x)
        : undefined;

/** A phase's numbers; an array counts as its length. Text is never kept. */
const countsOf = (d: Record<string, unknown>) => {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(d)) {
        if (key === "phase" || key === "name") continue;
        const n = Array.isArray(value) ? value.length : num(value);
        if (n !== undefined) counts[key] = n;
    }
    return Object.keys(counts).length ? counts : undefined;
};

/** Folds stream events into what the Run screen draws. Unknown events are ignored. */
export const reduceRunStream = (
    events: RunStreamEvent[],
    from: RunStreamView = EMPTY_RUN_STREAM_VIEW,
): RunStreamView => {
    const view: RunStreamView = {
        states: [...from.states],
        phases: [...from.phases],
        steps: [...from.steps],
        verdict: from.verdict,
        published: [...from.published],
    };
    const stepIndex = new Map(view.steps.map((s, i) => [s.stepId, i]));

    for (const event of events) {
        const d = event.data ?? {};
        switch (event.type) {
            case "state": {
                const state = d.state;
                if (!isRunState(state)) break;
                const last = view.states.at(-1);
                if (last?.state === state) break;
                view.states.push({
                    state,
                    at: event.at,
                    reason: str(d.reason),
                });
                break;
            }
            case "phase": {
                const phase = str(d.phase) ?? str(d.name);
                if (phase)
                    view.phases.push({
                        phase,
                        at: event.at,
                        counts: countsOf(d),
                    });
                break;
            }
            case "step.started":
            case "step.finished": {
                const stepId = str(d.stepId);
                if (!stepId) break;
                const idx = stepIndex.get(stepId);
                const prev = idx === undefined ? { stepId } : view.steps[idx];
                const next: RunStepView = {
                    ...prev,
                    side: str(d.side) ?? prev.side,
                    kind: str(d.kind) ?? prev.kind,
                    probeId: str(d.probeId) ?? prev.probeId,
                    label:
                        str(d.purpose) ??
                        str(d.label) ??
                        str(d.command) ??
                        prev.label,
                };
                if (event.type === "step.started") {
                    next.startedAt = prev.startedAt ?? event.at;
                } else {
                    next.finishedAt = event.at;
                    next.durationMs = num(d.durationMs) ?? prev.durationMs;
                    next.exitCode = num(d.exitCode) ?? prev.exitCode;
                    next.status = num(d.status) ?? prev.status;
                    next.transport = str(d.transport) ?? prev.transport;
                    next.verdict = str(d.verdict) ?? prev.verdict;
                    next.outcome = str(d.outcome) ?? prev.outcome;
                    next.vmHealth = str(d.vmHealth) ?? prev.vmHealth;
                }
                if (idx === undefined) {
                    stepIndex.set(stepId, view.steps.length);
                    view.steps.push(next);
                } else {
                    view.steps[idx] = next;
                }
                break;
            }
            case "verdict": {
                const check = d.check as
                    { conclusion?: unknown; title?: unknown } | undefined;
                view.verdict = {
                    at: event.at,
                    verdictState: str(d.verdictState) as
                        VerdictState | undefined,
                    check:
                        check && str(check.conclusion) && str(check.title)
                            ? {
                                  conclusion:
                                      check.conclusion as CheckConclusion,
                                  title: check.title as string,
                              }
                            : undefined,
                    findings: Array.isArray(d.findings)
                        ? (d.findings as ProbeVerdict[])
                        : undefined,
                    forcedNeutral: strings(d.forcedNeutral),
                    uncovered: strings(d.uncovered),
                    intended: num(d.intended),
                    rejectedProbes: num(d.rejectedProbes),
                    rejectedReasons: strings(d.rejectedReasons),
                };
                break;
            }
            case "published":
                view.published.push({
                    at: event.at,
                    kind: str(d.kind),
                    url: str(d.url),
                });
                break;
        }
    }
    return view;
};

export const lastStreamState = (view: RunStreamView): RunState | undefined =>
    view.states.at(-1)?.state;

const isEvent = (e: unknown): e is RunStreamEvent =>
    !!e &&
    typeof e === "object" &&
    (RUN_STREAM_EVENT_TYPES as readonly string[]).includes(
        (e as RunStreamEvent).type,
    ) &&
    typeof (e as RunStreamEvent).at === "string";

/**
 * Reads one stream response. The body may be the page itself, the page in the
 * API's `{ data }` envelope, or a bare event array (Durable Streams JSON
 * mode); the `Stream-Next-Offset` and `Stream-Up-To-Date` headers fill what
 * the body leaves out.
 */
export const parseStreamResponse = (
    body: unknown,
    headers: { get(name: string): string | null },
    requestedOffset?: string,
): RunStreamPage => {
    let payload: unknown = body;
    if (
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        "data" in payload &&
        !("events" in payload)
    ) {
        payload = (payload as { data: unknown }).data;
    }
    const events = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as RunStreamPage | null)?.events)
          ? (payload as RunStreamPage).events
          : [];
    const bodyOffset = (payload as RunStreamPage | null)?.nextOffset;
    const headerOffset = headers.get("Stream-Next-Offset");
    const nextOffset =
        (typeof bodyOffset === "string" && bodyOffset) ||
        headerOffset ||
        requestedOffset ||
        "-1";
    const bodyUpToDate = (payload as RunStreamPage | null)?.upToDate;
    const headerUpToDate = headers.get("Stream-Up-To-Date");
    const upToDate =
        typeof bodyUpToDate === "boolean"
            ? bodyUpToDate
            : headerUpToDate != null
              ? headerUpToDate === "true" || headerUpToDate === ""
              : false;
    return { events: events.filter(isEvent), nextOffset, upToDate };
};

/** A read that must not be retried (403, invalid offset): the loop stops. */
export class RunStreamFatalError extends Error {
    constructor(
        message: string,
        readonly statusCode?: number,
    ) {
        super(message);
        this.name = "RunStreamFatalError";
    }
}

export const streamBackoffMs = (failures: number) =>
    Math.min(1000 * 2 ** Math.max(0, failures - 1), 15_000);

const defaultWait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

export type FollowRunStreamOptions = {
    /** `null` means the stream does not exist yet (404): wait and ask again. */
    readPage: (
        offset: string | undefined,
        signal: AbortSignal,
    ) => Promise<RunStreamPage | null>;
    onEvents: (events: RunStreamEvent[], nextOffset: string) => void;
    onStatus?: (
        status: "live" | "reconnecting" | "waiting" | "paused" | "done",
    ) => void;
    /** True once the Run is terminal by some other source (the projection). */
    isTerminal?: () => boolean;
    signal: AbortSignal;
    startOffset?: string;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Floor between two empty up-to-date reads, in case the server does not hold the long-poll. */
    idleDelayMs?: number;
    /**
     * Reads answered 404 in a row before giving up (default 30, about a
     * minute): a stream that never appears is reported, not polled forever.
     */
    maxMissingReads?: number;
    /** The tab is hidden: nothing is read until untilVisible resolves. */
    isHidden?: () => boolean;
    untilVisible?: (signal: AbortSignal) => Promise<void>;
    now?: () => number;
};

export const DEFAULT_MAX_MISSING_STREAM_READS = 30;

/** A Run with no event for this long is quiet: its stream is read less often. */
export const QUIET_STREAM_AFTER_MS = 10 * 60_000;
/** Between two empty reads of a quiet stream (a stuck or long-waiting Run). */
export const QUIET_STREAM_IDLE_DELAY_MS = 30_000;

/**
 * Follows a Run's stream until it is terminal and caught up. Ends after the
 * `published` event, or after two empty reads past the terminal state (the
 * publish can come later, or never, e.g. for a superseded Run).
 */
export const followRunStream = async (
    opts: FollowRunStreamOptions,
): Promise<void> => {
    const wait = opts.wait ?? defaultWait;
    const idleDelayMs = opts.idleDelayMs ?? 1000;
    const now = opts.now ?? Date.now;
    let lastEventAt = now();
    let offset = opts.startOffset;
    let failures = 0;
    let terminal = false;
    let published = false;
    let emptyAfterTerminal = 0;
    let missing = 0;
    const maxMissing = opts.maxMissingReads ?? DEFAULT_MAX_MISSING_STREAM_READS;

    while (!opts.signal.aborted) {
        // A hidden tab reads nothing (WP8): it picks up from its offset when shown.
        if (opts.isHidden?.() && opts.untilVisible) {
            opts.onStatus?.("paused");
            await opts.untilVisible(opts.signal);
            if (opts.signal.aborted) return;
        }
        let page: RunStreamPage | null;
        try {
            page = await opts.readPage(offset, opts.signal);
        } catch (error) {
            if (opts.signal.aborted) return;
            if (error instanceof RunStreamFatalError) throw error;
            failures += 1;
            opts.onStatus?.("reconnecting");
            await wait(streamBackoffMs(failures), opts.signal);
            continue;
        }
        if (opts.signal.aborted) return;
        failures = 0;

        if (page === null) {
            if (opts.isTerminal?.()) {
                opts.onStatus?.("done");
                return;
            }
            missing += 1;
            if (missing >= maxMissing)
                throw new RunStreamFatalError("stream not found", 404);
            opts.onStatus?.("waiting");
            await wait(2000, opts.signal);
            continue;
        }
        missing = 0;

        opts.onStatus?.("live");
        if (page.events.length > 0) {
            lastEventAt = now();
            opts.onEvents(page.events, page.nextOffset);
            for (const e of page.events) {
                if (
                    e.type === "state" &&
                    isRunState(e.data?.state) &&
                    isTerminalRunState(e.data.state as RunState)
                )
                    terminal = true;
                if (e.type === "published") published = true;
            }
        }
        offset = page.nextOffset;

        const done = terminal || opts.isTerminal?.() === true;
        if (page.upToDate && done) {
            if (published) break;
            if (page.events.length === 0) emptyAfterTerminal += 1;
            if (emptyAfterTerminal >= 2) break;
        }
        if (page.upToDate && page.events.length === 0)
            await wait(
                now() - lastEventAt >= QUIET_STREAM_AFTER_MS
                    ? QUIET_STREAM_IDLE_DELAY_MS
                    : idleDelayMs,
                opts.signal,
            );
    }
    if (!opts.signal.aborted) opts.onStatus?.("done");
};
