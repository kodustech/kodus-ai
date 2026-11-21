import type { EvidenceUploadType } from '@libs/runtime/contracts/evidence';
import type { BrowserStepError, BrowserStepKind, Probe, ProbeResult } from '@libs/runtime/probe';
import { browserStepTargetOf } from '@libs/runtime/probe/exercised';

// Replay lanes (EVIDENCE-CAPTURE-DESIGN "Product"): what main and the PR did
// while one probe round ran, on the round's own clock (ms since t0, when the
// cell started the probe), in the order request → service logs → database →
// outbound → response, and the first event where the two sides part.
//
// Built from what the cell captured, which the verdict never reads: a lane
// only shows the gate's decision, it never makes one. A block a cell did not
// capture (an older cell, no feature) is `captured: false` and reads "not
// captured on this cell"; it is never compared, so it cannot be a difference.

export const LANE_EVENT_KINDS = ['request', 'log', 'db', 'outbound', 'response'] as const;
export type LaneEventKind = (typeof LANE_EVENT_KINDS)[number];

/** The blocks a cell may or may not have captured. The response is always there when the round answered. */
export const LANE_BLOCKS = ['requests', 'logs', 'db', 'outbound'] as const;
export type LaneBlock = (typeof LANE_BLOCKS)[number];

export const LANE_MAX_EVENTS = 40;
export const LANE_LABEL_MAX = 200;

export interface LaneEvent {
    kind: LaneEventKind;
    /** Ms since the round's t0. */
    at: number;
    /**
     * What happened, as text the cell already redacted, cut to 200 characters:
     * `GET /orders/:id → 500`, a log line, `public.orders +1 ~0 -0`,
     * `api.stripe.com:443 blocked`, `status 500` or `exit 1`.
     */
    label: string;
    /** The compose service a log line or a table came from. */
    service?: string;
}

export const BROWSER_LANE_MAX_ENTRIES = 50;

/** One browser step on a lane (ADR-071): what it did, how it ended, on the round's clock, and its images. */
export interface BrowserLaneStep {
    index: number;
    kind: BrowserStepKind;
    /** `click #place`, `expectText #orders "keyboard"`: the probe's step, cut to 200 characters. */
    label: string;
    /**
     * What the step acts on, from the probe's step only (`#orders`, `/login`):
     * never the text it types or expects. Redacted, at most 128 characters;
     * what the PR comment names (exercised.ts browserStepTargetOf).
     */
    target?: string;
    ok: boolean;
    error?: BrowserStepError;
    startMs: number;
    endMs: number;
    /** What an expectText or getAttribute step read (the cell redacted it). */
    value?: string;
    /** The screenshot this step took (screenshot-N). */
    screenshot?: EvidenceUploadType;
    /** Its pixel diff against main's baseline round, when the cell measured it: the image and the changed share. */
    pixeldiff?: EvidenceUploadType;
    ratio?: number;
}

/** A browser probe's round on a lane: its steps, where the video starts, the page's console and network (from the HAR). */
export interface BrowserLane {
    steps: BrowserLaneStep[];
    /** When the video's first frame was, on the round's clock: a step at startMs is at startMs - videoStartMs in the video. */
    videoStartMs?: number;
    console: Array<{ level: string; text: string; at?: number }>;
    network: Array<{ method: string; url: string; status: number; at?: number; ms?: number }>;
    /** Console or network entries were cut to 50 here. */
    truncated: boolean;
}

export interface ReplayLane {
    side: 'base' | 'pr';
    round: number;
    /** The round's step: its evidence is {orgId}/{runId}/{side}/{stepId}/{type} (GET /runtime/runs/:id/evidence/:stepId?side&type). */
    stepId: string;
    /** When the cell started the probe (its clock); absent from a cell that captures nothing. */
    t0?: string;
    /** How long the window [t0, t1] lasted, in ms. */
    windowMs?: number;
    /** In lane order (request, log, db, outbound, response), each by time; at most 40. */
    events: LaneEvent[];
    /** Which blocks the cell captured this round; false is "not captured", not "nothing happened". */
    captured: Record<LaneBlock, boolean>;
    /** Artifacts the cell uploaded for this round (open them by `type`). */
    artifacts: Array<{ type: EvidenceUploadType; bytes: number; truncated: boolean }>;
    /** Events or log lines were cut (by the cell or to 40 here). */
    truncated: boolean;
    /** A browser probe's round (absent for http and sql, and from a cell without a browser runner). */
    browser?: BrowserLane;
}

export interface ReplayLanes {
    base: ReplayLane;
    pr: ReplayLane;
    /** A browser probe: the first step whose outcome or value differs between main and the PR. Absent: the steps agree. */
    firstStepDifference?: number;
    /**
     * The first place the lanes part, comparing only blocks both sides
     * captured: its position in the compared sequence and each side's event
     * there (absent on the side that has none). Absent: the lanes match.
     */
    firstDifference?: { index: number; kind: LaneEventKind; base?: LaneEvent; pr?: LaneEvent };
}

const clip = (s: string) => (s.length > LANE_LABEL_MAX ? `${s.slice(0, LANE_LABEL_MAX - 1)}…` : s);
const ORDER: Record<LaneEventKind, number> = { request: 0, log: 1, db: 2, outbound: 3, response: 4 };

/** The probe's browser step as a lane label: its kind and arguments, in the probe's words. */
export function browserStepLabel(step: unknown): string {
    if (!step || typeof step !== 'object') return 'step';
    const [kind, value] = Object.entries(step as Record<string, unknown>)[0] ?? ['step', ''];
    const args = Array.isArray(value) ? `${value[0]} ${JSON.stringify(value[1])}` : String(value);
    return clip(`${kind} ${args}`);
}

function browserLane(result: ProbeResult, probe: Probe | undefined): BrowserLane | undefined {
    const b = result.browser;
    if (!b?.steps?.length) return undefined;
    const uploaded = new Set((result.evidence?.refs ?? []).map((r) => r.type));
    const spec = probe?.spec.kind === 'browser' ? probe.spec : undefined;
    const steps: BrowserLaneStep[] = b.steps.map((s) => {
        const target = browserStepTargetOf(spec?.steps[s.index]);
        const shot = s.screenshot !== undefined ? (`screenshot-${s.screenshot}` as EvidenceUploadType) : undefined;
        const diff = s.screenshot !== undefined ? b.pixels?.find((p) => p.screenshot === s.screenshot) : undefined;
        const diffType = diff ? (`pixeldiff-${diff.screenshot}` as EvidenceUploadType) : undefined;
        return {
            index: s.index,
            kind: s.kind,
            label: spec?.steps[s.index] ? browserStepLabel(spec.steps[s.index]) : s.kind,
            ...(target ? { target } : {}),
            ok: s.ok,
            ...(s.error ? { error: s.error } : {}),
            startMs: s.startMs,
            endMs: s.endMs,
            ...(s.value !== undefined ? { value: clip(s.value) } : {}),
            ...(shot && uploaded.has(shot) ? { screenshot: shot } : {}),
            ...(diffType && uploaded.has(diffType) ? { pixeldiff: diffType } : {}),
            ...(diff ? { ratio: diff.ratio } : {}),
        };
    });
    const console = b.console.slice(0, BROWSER_LANE_MAX_ENTRIES).map((c) => ({ level: c.level, text: clip(c.text), ...(c.at !== undefined ? { at: c.at } : {}) }));
    const network = b.network.slice(0, BROWSER_LANE_MAX_ENTRIES).map((n) => ({
        method: n.method,
        url: clip(n.url),
        status: n.status,
        ...(n.at !== undefined ? { at: n.at } : {}),
        ...(n.ms !== undefined ? { ms: n.ms } : {}),
    }));
    return {
        steps,
        ...(b.videoStartMs !== undefined ? { videoStartMs: b.videoStartMs } : {}),
        console,
        network,
        truncated: b.console.length > BROWSER_LANE_MAX_ENTRIES || b.network.length > BROWSER_LANE_MAX_ENTRIES,
    };
}

/** One side's lane from its round's observer result (already redacted). */
export function laneOf(args: { side: 'base' | 'pr'; round: number; stepId: string; result: ProbeResult; probe?: Probe }): ReplayLane {
    const { result } = args;
    const ev = result.evidence;
    const timed = result.requests.length > 0 && result.requests.every((r) => typeof r.at === 'number');
    const events: LaneEvent[] = [];
    if (timed) for (const r of result.requests) events.push({ kind: 'request', at: r.at!, label: clip(`${r.method} ${r.route} → ${r.status}`) });
    for (const l of ev?.logs?.tail ?? []) events.push({ kind: 'log', at: l.at, service: l.service, label: clip(l.text) });
    const end = ev?.windowMs ?? result.durationMs;
    for (const t of ev?.db?.tables ?? []) {
        events.push({ kind: 'db', at: end, service: ev!.db!.service, label: clip(`${t.table} +${t.inserted} ~${t.updated} -${t.deleted}`) });
    }
    for (const c of ev?.outbound?.calls ?? []) events.push({ kind: 'outbound', at: c.at, label: clip(`${c.host}:${c.port} ${c.allowed ? 'allowed' : 'blocked'}`) });
    const steps = result.browser?.steps;
    const page = steps?.length ? `${steps.filter((x) => x.ok).length}/${steps.length} steps passed` : 'page';
    const response = result.http ? `status ${result.http.status}` : result.sql ? `${result.sql.rows.length} rows` : result.browser ? page : undefined;
    if (response) events.push({ kind: 'response', at: result.durationMs, label: result.transport === 'lost' ? `${response} (cut off)` : response });
    events.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.at - b.at);
    // Keep the response: it is the lane's end. Logs are cut first, from the oldest.
    let kept = events;
    if (kept.length > LANE_MAX_EVENTS) {
        let over = kept.length - LANE_MAX_EVENTS;
        kept = kept.filter((e) => !(e.kind === 'log' && over > 0 && over-- > 0));
    }
    if (kept.length > LANE_MAX_EVENTS) {
        const responses = kept.filter((e) => e.kind === 'response');
        kept = [...kept.filter((e) => e.kind !== 'response').slice(0, LANE_MAX_EVENTS - responses.length), ...responses];
    }
    return {
        side: args.side,
        round: args.round,
        stepId: args.stepId,
        ...(ev ? { t0: ev.t0, windowMs: ev.windowMs } : {}),
        events: kept,
        captured: { requests: timed, logs: !!ev?.logs, db: !!ev?.db, outbound: !!ev?.outbound },
        artifacts: (ev?.refs ?? []).map((r) => ({ type: r.type, bytes: r.bytes, truncated: r.truncated })),
        truncated: kept.length < events.length || !!ev?.logs?.truncated || !!ev?.db?.truncated || !!ev?.outbound?.truncated,
        ...optionalBrowser(browserLane(result, args.probe)),
    };
}

const optionalBrowser = (b: BrowserLane | undefined) => (b ? { browser: b } : {});

/** The first step whose outcome or what it read differs between the two sides; undefined when they agree. */
export function firstStepDifferenceOf(base: BrowserLane | undefined, pr: BrowserLane | undefined): number | undefined {
    if (!base || !pr) return undefined;
    for (let i = 0; i < Math.max(base.steps.length, pr.steps.length); i++) {
        const a = base.steps[i];
        const b = pr.steps[i];
        if (!a || !b || a.ok !== b.ok || (a.error ?? '') !== (b.error ?? '') || (a.value ?? '') !== (b.value ?? '')) return i;
    }
    return undefined;
}

const BLOCK_OF: Record<Exclude<LaneEventKind, 'response'>, LaneBlock> = { request: 'requests', log: 'logs', db: 'db', outbound: 'outbound' };

/** Text that varies between two runs of the same code (ids, times, counters) compares as equal. */
export function normalizeLaneLabel(label: string): string {
    return label
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
        .replace(/\b[0-9a-f]{16,}\b/gi, '#')
        .replace(/\d+(\.\d+)?/g, '#');
}

/**
 * Main and the PR lined up, with the first difference. `responseDiffers`
 * is the gate's own reading (the probe's differing fields), so a body that
 * changed under the same status still marks the response.
 */
export function replayLanesOf(base: ReplayLane, pr: ReplayLane, opts: { responseDiffers?: boolean } = {}): ReplayLanes {
    const step = firstStepDifferenceOf(base.browser, pr.browser);
    const lanes = replayLanesOfEvents(base, pr, opts);
    return step === undefined ? lanes : { ...lanes, firstStepDifference: step };
}

function replayLanesOfEvents(base: ReplayLane, pr: ReplayLane, opts: { responseDiffers?: boolean }): ReplayLanes {
    const both = (e: LaneEvent) => e.kind === 'response' || (base.captured[BLOCK_OF[e.kind]] && pr.captured[BLOCK_OF[e.kind]]);
    const a = base.events.filter(both);
    const b = pr.events.filter(both);
    // Requests keep their status (it is the difference), every other label is normalized.
    const key = (e: LaneEvent) => `${e.kind}\u0000${e.service ?? ''}\u0000${e.kind === 'response' || e.kind === 'request' ? e.label : normalizeLaneLabel(e.label)}`;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i];
        const y = b[i];
        const differs = !x || !y || key(x) !== key(y) || (x.kind === 'response' && opts.responseDiffers);
        if (differs) {
            const kind = (x && y ? (ORDER[x.kind] <= ORDER[y.kind] ? x : y) : (x ?? y))!.kind;
            return { base, pr, firstDifference: { index: i, kind, ...(x ? { base: x } : {}), ...(y ? { pr: y } : {}) } };
        }
    }
    return { base, pr };
}
