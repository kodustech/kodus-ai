import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What each job in flight on this process is doing, kept up to date as it
 * runs: the job, then the pipeline stage and the PR, then the agent tool in
 * flight. The stall watchdog reads the last snapshot, sent to its thread
 * before the main thread froze, so a stall report names the job, the PR and
 * the tool call that froze it (on 2026-11-19 that took hours of log
 * correlation per stall).
 *
 * A job's code reaches its own entry through AsyncLocalStorage: no id is
 * passed down. Outside a job (startup, crons) every call is a no-op.
 */
export interface ActivityTool {
    tool: string;
    /** A short summary of the call's arguments (pattern, path, ...). */
    args?: string;
    since: number;
}

export interface ActivityInfo {
    jobId: string;
    queue?: string;
    workflowType?: string;
    startedAt: number;
    pipeline?: string;
    stage?: string;
    organizationId?: string;
    repository?: string;
    prNumber?: number;
    platform?: string;
    changedFiles?: number;
    changedLines?: number;
    /** Agent tool calls in flight (agents of one job run in parallel). */
    tools?: ActivityTool[];
}

type Entry = ActivityInfo & { toolCalls: Map<number, ActivityTool> };

const MAX_JOBS = 40;
const MAX_TOOLS = 8;
const MAX_TEXT = 300;

const als = new AsyncLocalStorage<{ run: number }>();
// Keyed by run, not job: a job whose claim was taken over can run twice
// on one process, and each run keeps its own entry.
const active = new Map<number, Entry>();
let nextRun = 1;
let nextToolCall = 1;
let listener: ((snapshot: ActivityInfo[]) => void) | null = null;
let notifyQueued = false;

const clip = (v: unknown) =>
    v === undefined || v === null ? undefined : String(v).slice(0, MAX_TEXT);

function notify(): void {
    if (!listener || notifyQueued) return;
    // Coalesced: many updates in one turn send one snapshot. A microtask,
    // so it still leaves before synchronous work queued after an await.
    notifyQueued = true;
    queueMicrotask(() => {
        notifyQueued = false;
        try {
            listener?.(activitySnapshot());
        } catch {
            // observability must never break a job
        }
    });
}

/** Runs `fn` as job `jobId`; its entry lives until `fn` settles. */
export async function runActivity<T>(
    jobId: string,
    info: Partial<Omit<ActivityInfo, 'jobId' | 'startedAt' | 'tools'>>,
    fn: () => Promise<T>,
): Promise<T> {
    const run = nextRun++;
    active.set(run, {
        ...info,
        jobId,
        startedAt: Date.now(),
        toolCalls: new Map(),
    });
    notify();
    try {
        return await als.run({ run }, fn);
    } finally {
        active.delete(run);
        notify();
    }
}

/** Updates the current job's entry (no-op outside a job). */
export function updateActivity(
    patch: Partial<Omit<ActivityInfo, 'jobId' | 'startedAt' | 'tools'>>,
): void {
    const run = als.getStore()?.run;
    const entry = run ? active.get(run) : undefined;
    if (!entry) return;
    for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined)
            (entry as any)[k] = typeof v === 'string' ? clip(v) : v;
    }
    notify();
}

/**
 * Marks a tool call in flight for the current job; returns the function
 * that ends it. Safe to call outside a job.
 */
export function beginToolActivity(tool: string, args?: string): () => void {
    const run = als.getStore()?.run;
    const entry = run ? active.get(run) : undefined;
    if (!entry) return () => undefined;
    const call = nextToolCall++;
    entry.toolCalls.set(call, {
        tool: clip(tool) ?? '',
        args: clip(args),
        since: Date.now(),
    });
    notify();
    return () => {
        entry.toolCalls.delete(call);
        notify();
    };
}

/** The current job's entry (no-op outside a job), bounded like a snapshot. */
export function currentActivity(): ActivityInfo | undefined {
    const run = als.getStore()?.run;
    const entry = run ? active.get(run) : undefined;
    if (!entry) return undefined;
    const { toolCalls, ...info } = entry;
    const tools = [...toolCalls.values()].slice(0, MAX_TOOLS);
    return tools.length ? { ...info, tools } : info;
}

/** Bounded copy of what runs now, safe to post to another thread. */
export function activitySnapshot(): ActivityInfo[] {
    const out: ActivityInfo[] = [];
    for (const e of active.values()) {
        if (out.length >= MAX_JOBS) break;
        const { toolCalls, ...info } = e;
        // The oldest calls first: the long-running one is the likeliest to
        // be what froze the thread.
        const tools = [...toolCalls.values()].slice(0, MAX_TOOLS);
        out.push(tools.length ? { ...info, tools } : info);
    }
    return out;
}

export interface ActivityCounts {
    /** Every job in flight on this process, not capped like a snapshot. */
    total: number;
    byWorkflowType: Record<string, number>;
    /**
     * Size of the code reviews in flight, from the PR sizes their jobs
     * carry (GitHub only). `withSize` says how many reviews it covers.
     */
    reviews: {
        withSize: number;
        changedFilesSum: number;
        changedFilesMax: number;
        changedLinesSum: number;
    };
}

/** How many jobs run now and how big the reviews among them are. */
export function activityCounts(): ActivityCounts {
    const counts: ActivityCounts = {
        total: 0,
        byWorkflowType: {},
        reviews: {
            withSize: 0,
            changedFilesSum: 0,
            changedFilesMax: 0,
            changedLinesSum: 0,
        },
    };
    for (const e of active.values()) {
        counts.total++;
        const type = e.workflowType ?? 'unknown';
        counts.byWorkflowType[type] =
            (Object.hasOwn(counts.byWorkflowType, type)
                ? counts.byWorkflowType[type]
                : 0) + 1;
        if (type === 'CODE_REVIEW' && e.changedFiles !== undefined) {
            const r = counts.reviews;
            r.withSize++;
            r.changedFilesSum += e.changedFiles;
            r.changedFilesMax = Math.max(r.changedFilesMax, e.changedFiles);
            r.changedLinesSum += e.changedLines ?? 0;
        }
    }
    return counts;
}

/** One listener (the stall watchdog); null removes it. */
export function onActivityChange(
    fn: ((snapshot: ActivityInfo[]) => void) | null,
): void {
    listener = fn;
    if (fn) notify();
}
