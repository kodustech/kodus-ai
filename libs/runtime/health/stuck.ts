import { HARD_EXPIRY_MINUTES, LEASE_TTL_MINUTES, readyTimeoutMinutes, type Consumer } from '@libs/runtime/environment/environment-runtime';
import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';

// The hang detector's rule (docs/runtime/observability.md part 4): for every
// state that is not final, the longest the code lets a Run, a setup, a claim,
// a sandbox, an admission request, a DBOS workflow or a cell stay in it, from
// the code's own timeouts and ceilings. Anything past its bound is stuck: it
// is reported (event, metric, screen), never acted on. Pure: the worker's
// maintenance pass and the API's Health route give it the rows they read.

const MINUTE = 60_000;

/**
 * The code's own limits this file is built from. The ones that live in
 * apps/runtime (a lib cannot import an app) are repeated here, and
 * apps/runtime/src/worker/maintenance/stuck-bounds.spec.ts keeps them equal.
 */
export const RUNTIME_LIMITS = {
    /** run-orchestrator.ts QUEUE_TIMEOUT_MS: a Run longer in the queue times out. */
    queueTimeoutMs: 30 * MINUTE,
    /** run-orchestrator.ts RUN_TIMEOUT_MS: booting/testing, from max(bootingAt, capacityWait.at). */
    runTimeoutMs: 45 * MINUTE,
    /** run-engine.service.ts queuedPastLimit: the margin for the consumer's retries before "never started". */
    neverStartedMarginMs: 5 * MINUTE,
    /** run-engine.service.ts APPROVAL_WAIT_SECONDS and admission-contract.ts ADMISSION_APPROVAL_MS: a fork's approval. */
    approvalWaitMs: 7 * 24 * 60 * MINUTE,
    /** admission-contract.ts ADMISSION_WAIT_MS: an admission request's deadline from its acceptance. */
    admissionWaitMs: 30 * MINUTE,
    /** environment-setup.service.ts SETUP_CAPACITY_WAIT_MS: a setup waiting for room. */
    setupCapacityWaitMs: 30 * MINUTE,
    /** http-recipe-author.ts RECIPE_AUTHOR_CLIENT_TIMEOUT_MS: one call to Kody's recipe author. */
    recipeAuthorMs: 11 * MINUTE,
    /** run-engine.service.ts PUBLISH_STEP_RETRY: 8 tries, 5 s doubling (5+10+…+320 s ≈ 10.6 min). */
    publishRetriesMs: (5 + 10 + 20 + 40 + 80 + 160 + 320) * 1_000,
    /** cell-hub.ts CELL_SILENCE_MS: a cell silent longer is dropped by the hub. */
    cellSilenceMs: 45_000,
    /** cell-gateway.service.ts SILENCE_TICK_MS: how often the hub checks. */
    silenceTickMs: 5_000,
    /** run-engine.service.ts: the maintenance pass runs every 15 s on the replica that holds its lock. */
    maintenanceTickMs: 15_000,
} as const;

/**
 * What the detector adds to every bound before it calls an item stuck: a few
 * maintenance passes (the loop that ends a Run past its limit, releases a
 * claim past its ceiling) and one stop workflow's publication retries.
 */
export const STUCK_GRACE_MS = 4 * RUNTIME_LIMITS.maintenanceTickMs + 60_000;

/** The longest one setup can take: admission, a wait for room, then each try (Kody's author, then a boot to its ceiling), repairs at their maximum. */
export const SETUP_CEILING_MS =
    RUNTIME_LIMITS.admissionWaitMs + RUNTIME_LIMITS.setupCapacityWaitMs + (1 + SETUP_AUTHOR_REPAIRS_MAX) * (RUNTIME_LIMITS.recipeAuthorMs + HARD_EXPIRY_MINUTES.setup * MINUTE);
/** The longest a setup goes without saving its record: one boot to its ceiling (a boot saves when it ends). */
export const SETUP_NO_PROGRESS_MS = HARD_EXPIRY_MINUTES.setup * MINUTE + RUNTIME_LIMITS.recipeAuthorMs;

export type StuckSubject = 'run' | 'setup' | 'claim' | 'sandbox' | 'admission' | 'workflow' | 'cell' | 'setup_queue';

/** One row of the bounds table: a state, its bound, where the bound comes from in the code. */
export interface StuckBound {
    subject: StuckSubject;
    state: string;
    /** The bound in ms, or a description when it depends on the row (a claim's own ceiling). */
    boundMs: number | 'row';
    from: string;
    source: string;
}

/** Every bound the detector applies, in the order the doc's table lists them. */
export const STUCK_BOUNDS: readonly StuckBound[] = [
    { subject: 'run', state: 'queued', boundMs: RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs, from: 'requestedAt', source: 'run-orchestrator.ts QUEUE_TIMEOUT_MS + run-engine.service.ts queuedPastLimit' },
    { subject: 'run', state: 'awaiting_approval', boundMs: RUNTIME_LIMITS.approvalWaitMs, from: 'requestedAt', source: 'run-engine.service.ts APPROVAL_WAIT_SECONDS' },
    { subject: 'run', state: 'booting', boundMs: RUNTIME_LIMITS.runTimeoutMs, from: 'max(bootingAt, capacityWait.at)', source: 'run-orchestrator.ts RUN_TIMEOUT_MS, run-engine.service.ts runPastLimit' },
    { subject: 'run', state: 'testing', boundMs: RUNTIME_LIMITS.runTimeoutMs, from: 'max(bootingAt, capacityWait.at)', source: 'run-orchestrator.ts RUN_TIMEOUT_MS, run-engine.service.ts runPastLimit' },
    { subject: 'setup', state: 'setting_up', boundMs: SETUP_CEILING_MS, from: 'requestedAt', source: 'ADMISSION_WAIT_MS + SETUP_CAPACITY_WAIT_MS + (1 + SETUP_AUTHOR_REPAIRS_MAX) × (RECIPE_AUTHOR_CLIENT_TIMEOUT_MS + HARD_EXPIRY_MINUTES.setup)' },
    { subject: 'setup', state: 'no_progress', boundMs: SETUP_NO_PROGRESS_MS, from: 'updatedAt', source: 'HARD_EXPIRY_MINUTES.setup + RECIPE_AUTHOR_CLIENT_TIMEOUT_MS' },
    { subject: 'setup_queue', state: 'no_progress', boundMs: SETUP_NO_PROGRESS_MS, from: 'the newest updatedAt of the setups setting up', source: 'as setup no_progress, over every setup of the cluster' },
    { subject: 'claim', state: 'pending', boundMs: 'row', from: 'stateChangedAt', source: 'READY_TIMEOUT_MINUTES (PR side PR_BUILD_READY_TIMEOUT_MINUTES), environment-runtime.ts' },
    { subject: 'claim', state: 'bound|held|blocked|failed|compromised', boundMs: 'row', from: 'hardExpiresAt', source: 'HARD_EXPIRY_MINUTES, released by the maintenance reap (run-deps.factory.ts reap)' },
    { subject: 'sandbox', state: 'pending', boundMs: 'row', from: 'stateChangedAt', source: 'READY_TIMEOUT_MINUTES.sandbox' },
    { subject: 'sandbox', state: 'bound|held|blocked|failed|compromised', boundMs: 'row', from: 'hardExpiresAt', source: 'HARD_EXPIRY_MINUTES.sandbox' },
    { subject: 'admission', state: 'waiting|owned|reserved|dispatched', boundMs: 'row', from: 'deadlineAt', source: 'admission-contract.ts ADMISSION_WAIT_MS (the row deadline_at)' },
    { subject: 'admission', state: 'awaiting_approval', boundMs: 'row', from: 'approvalDeadlineAt', source: 'admission-contract.ts ADMISSION_APPROVAL_MS' },
    { subject: 'workflow', state: 'ENQUEUED', boundMs: RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs, from: 'createdAt', source: 'as the Run queue bound; the admission queue enqueues with a delay up to deadlineAt' },
    { subject: 'workflow', state: 'PENDING runtimeRun', boundMs: RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.runTimeoutMs + RUNTIME_LIMITS.publishRetriesMs, from: 'createdAt', source: 'QUEUE_TIMEOUT_MS + RUN_TIMEOUT_MS + PUBLISH_STEP_RETRY' },
    { subject: 'workflow', state: 'PENDING runtimeEnvironmentSetup', boundMs: SETUP_CEILING_MS, from: 'createdAt', source: 'as setup setting_up' },
    { subject: 'workflow', state: 'PENDING runtimeRunStop', boundMs: RUNTIME_LIMITS.publishRetriesMs, from: 'createdAt', source: 'PUBLISH_STEP_RETRY' },
    { subject: 'workflow', state: 'PENDING runtimeForkGate', boundMs: RUNTIME_LIMITS.approvalWaitMs + RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.runTimeoutMs + RUNTIME_LIMITS.publishRetriesMs, from: 'createdAt', source: 'APPROVAL_WAIT_SECONDS, then the Run it waits for' },
    { subject: 'workflow', state: 'PENDING runtimeAdmission', boundMs: RUNTIME_LIMITS.admissionWaitMs, from: 'createdAt', source: 'ADMISSION_WAIT_MS' },
    { subject: 'cell', state: 'connected_silent', boundMs: RUNTIME_LIMITS.cellSilenceMs + 2 * RUNTIME_LIMITS.silenceTickMs, from: 'lastHeartbeatAt', source: 'cell-hub.ts CELL_SILENCE_MS + 2 × SILENCE_TICK_MS (the hub drops a silent cell; a session row still connected past it was not closed)' },
];

const boundOf = (subject: StuckSubject, state: string): number => {
    const b = STUCK_BOUNDS.find((x) => x.subject === subject && x.state === state);
    if (!b || b.boundMs === 'row') throw new Error(`no fixed bound for ${subject} ${state}`);
    return b.boundMs;
};

/** One item past its bound. Ids only: what the screen links and the event names. */
export interface StuckItem {
    subject: StuckSubject;
    state: string;
    /** Since when the bound counts, and how long ago that was. */
    since: string;
    ageMs: number;
    boundMs: number;
    organizationId?: string;
    runId?: string;
    environmentId?: string;
    setupKey?: string;
    claimId?: string;
    cellId?: string;
    workflowId?: string;
    consumer?: string;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const past = (fromMs: number, boundMs: number, now: number) => Number.isFinite(fromMs) && now - fromMs > boundMs + STUCK_GRACE_MS;

export interface RunRow {
    runId: string;
    organizationId: string;
    environmentId?: string | null;
    state: string;
    requestedAt: string;
    bootingAt?: string | null;
    capacityWait?: { at?: string } | null;
}

/** Runs past their state's bound (queued, awaiting_approval, booting, testing). */
export function stuckRuns(runs: readonly RunRow[], now: Date): StuckItem[] {
    const t = now.getTime();
    const out: StuckItem[] = [];
    for (const r of runs) {
        let from: number;
        let since: string | undefined;
        if (r.state === 'queued' || r.state === 'awaiting_approval') {
            from = ms(r.requestedAt);
            since = r.requestedAt;
        } else if (r.state === 'booting' || r.state === 'testing') {
            const booting = ms(r.bootingAt);
            const refused = ms(r.capacityWait?.at);
            from = Math.max(Number.isFinite(booting) ? booting : -Infinity, Number.isFinite(refused) ? refused : -Infinity);
            if (!Number.isFinite(from)) from = ms(r.requestedAt);
            since = new Date(from).toISOString();
        } else continue;
        const bound = boundOf('run', r.state);
        if (since && past(from, bound, t)) {
            out.push({ subject: 'run', state: r.state, since, ageMs: t - from, boundMs: bound, organizationId: r.organizationId, runId: r.runId, ...(r.environmentId ? { environmentId: r.environmentId } : {}) });
        }
    }
    return out;
}

export interface SetupRow {
    environmentId: string;
    organizationId: string;
    setupKey: string;
    state: string;
    requestedAt: string;
    updatedAt: string;
}

/** Setups setting up past their ceiling or without a saved step for longer than one boot; and the queue as a whole. */
export function stuckSetups(setups: readonly SetupRow[], now: Date): StuckItem[] {
    const t = now.getTime();
    const out: StuckItem[] = [];
    const live = setups.filter((s) => s.state === 'setting_up');
    for (const s of live) {
        const ids = { organizationId: s.organizationId, environmentId: s.environmentId, setupKey: s.setupKey };
        if (past(ms(s.requestedAt), SETUP_CEILING_MS, t)) {
            out.push({ subject: 'setup', state: 'setting_up', since: s.requestedAt, ageMs: t - ms(s.requestedAt), boundMs: SETUP_CEILING_MS, ...ids });
        } else if (past(ms(s.updatedAt), SETUP_NO_PROGRESS_MS, t)) {
            out.push({ subject: 'setup', state: 'no_progress', since: s.updatedAt, ageMs: t - ms(s.updatedAt), boundMs: SETUP_NO_PROGRESS_MS, ...ids });
        }
    }
    const newest = Math.max(...live.map((s) => ms(s.updatedAt)).filter(Number.isFinite));
    if (live.length > 1 && Number.isFinite(newest) && past(newest, SETUP_NO_PROGRESS_MS, t)) {
        out.push({ subject: 'setup_queue', state: 'no_progress', since: new Date(newest).toISOString(), ageMs: t - newest, boundMs: SETUP_NO_PROGRESS_MS });
    }
    return out;
}

export interface ClaimRowView {
    claimId: string;
    cellId: string;
    orgId: string;
    runId?: string | null;
    environmentId?: string | null;
    side: string;
    state: string;
    consumer?: string | null;
    stateChangedAt?: string | null;
    createdAt?: string | null;
    hardExpiresAt: string;
}

const OPEN = new Set(['pending', 'bound', 'held', 'blocked', 'failed', 'compromised']);

/** Open claims past their bound: pending past the ready wait, any open state past the hard ceiling. A sandbox is its own subject. */
export function stuckClaims(claims: readonly ClaimRowView[], now: Date): StuckItem[] {
    const t = now.getTime();
    const out: StuckItem[] = [];
    for (const c of claims) {
        if (!OPEN.has(c.state)) continue;
        const consumer = (c.consumer ?? 'runtime') as Consumer;
        const subject: StuckSubject = consumer === 'sandbox' ? 'sandbox' : 'claim';
        const ids = { organizationId: c.orgId, claimId: c.claimId, cellId: c.cellId, consumer, ...(c.runId ? { runId: c.runId } : {}), ...(c.environmentId ? { environmentId: c.environmentId } : {}) };
        const hard = ms(c.hardExpiresAt);
        if (past(hard, 0, t)) {
            out.push({ subject, state: c.state, since: c.hardExpiresAt, ageMs: t - hard, boundMs: 0, ...ids });
            continue;
        }
        if (c.state === 'pending') {
            const since = c.stateChangedAt ?? c.createdAt;
            // The hub's wait plus the minute the worker's call waits more (environment-runtime.ts).
            const bound = (readyTimeoutMinutes(consumer, c.side) + 1) * MINUTE;
            if (past(ms(since), bound, t)) out.push({ subject, state: 'pending', since: since!, ageMs: t - ms(since), boundMs: bound, ...ids });
        }
    }
    return out;
}

export interface AdmissionRowView {
    organizationId: string;
    kind: string;
    key: string;
    state: string;
    deadlineAt?: string | null;
    approvalDeadlineAt?: string | null;
    createdAt: string;
}

const ADMISSION_WAITING = new Set(['waiting', 'owned', 'reserved', 'dispatched']);

/** Admission requests past their own deadline (a request the repair loop should have ended). */
export function stuckAdmissions(rows: readonly AdmissionRowView[], now: Date): StuckItem[] {
    const t = now.getTime();
    const out: StuckItem[] = [];
    for (const r of rows) {
        const deadline = r.state === 'awaiting_approval' ? r.approvalDeadlineAt : ADMISSION_WAITING.has(r.state) ? r.deadlineAt : undefined;
        const at = ms(deadline);
        if (!past(at, 0, t)) continue;
        out.push({ subject: 'admission', state: r.state, since: deadline!, ageMs: t - ms(r.createdAt), boundMs: at - ms(r.createdAt), organizationId: r.organizationId, ...(r.kind === 'run' ? { runId: r.key } : { setupKey: r.key }) });
    }
    return out;
}

export interface WorkflowRowView {
    workflowId: string;
    name: string;
    status: string;
    createdAt: number;
}

/** DBOS workflows still ENQUEUED or PENDING past their bound. */
export function stuckWorkflows(rows: readonly WorkflowRowView[], now: Date): StuckItem[] {
    const t = now.getTime();
    const out: StuckItem[] = [];
    for (const w of rows) {
        const state = w.status === 'ENQUEUED' ? 'ENQUEUED' : w.status === 'PENDING' ? `PENDING ${w.name}` : undefined;
        const bound = state ? STUCK_BOUNDS.find((b) => b.subject === 'workflow' && b.state === state)?.boundMs : undefined;
        if (typeof bound !== 'number' || !past(w.createdAt, bound, t)) continue;
        out.push({ subject: 'workflow', state: state!, since: new Date(w.createdAt).toISOString(), ageMs: t - w.createdAt, boundMs: bound, workflowId: w.workflowId });
    }
    return out;
}

export interface CellSessionView {
    cellId: string;
    orgId?: string | null;
    lastHeartbeatAt: string;
    disconnectedAt?: string | null;
}

/** Cells whose session row says connected while no heartbeat came for longer than the hub's silence limit. */
export function stuckCells(rows: readonly CellSessionView[], now: Date): StuckItem[] {
    const t = now.getTime();
    const bound = boundOf('cell', 'connected_silent');
    return rows
        .filter((c) => !c.disconnectedAt && past(ms(c.lastHeartbeatAt), bound, t))
        .map((c) => ({ subject: 'cell' as const, state: 'connected_silent', since: c.lastHeartbeatAt, ageMs: t - ms(c.lastHeartbeatAt), boundMs: bound, cellId: c.cellId, ...(c.orgId ? { organizationId: c.orgId } : {}) }));
}

export { LEASE_TTL_MINUTES };
