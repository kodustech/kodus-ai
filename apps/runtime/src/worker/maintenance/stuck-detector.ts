import type { Pool } from 'pg';

import {
    type AdmissionRowView,
    type CellSessionView,
    type ClaimRowView,
    type RunRow,
    type SetupRow,
    type StuckItem,
    stuckAdmissions,
    stuckCells,
    stuckClaims,
    type QueueLimit,
    stuckRuns,
    stuckSetups,
    stuckWorkflows,
    type WorkflowRowView,
} from '@libs/runtime/health/stuck';
import { ATTR, METRIC, type RuntimeMetrics } from '@libs/runtime/telemetry';

// The hang detector (docs/runtime/observability.md part 4): one pass per
// maintenance tick, on the replica that holds the maintenance lock. It reads
// what is not final, applies the bounds of libs/runtime/health/stuck.ts, and
// reports: a `runtime.stuck` log line the first time an item crosses its
// bound, runtime.stuck.detected, and the gauges of its last pass (stuck items,
// open claims, admission queue). It never stops, releases or retries anything:
// that is the sweep's and the reap's job, and what they missed is what this sees.

/** What one pass reads. Every list is bounded; a source that fails is "not read" for the pass, never zero. */
export interface StuckSource {
    runs(): Promise<RunRow[]>;
    setups(): Promise<SetupRow[]>;
    claims(): Promise<ClaimRowView[]>;
    admissions(): Promise<AdmissionRowView[]>;
    cells(): Promise<CellSessionView[]>;
    workflows(): Promise<WorkflowRowView[]>;
    claimCounts(): Promise<Array<{ state: string; consumer: string; count: number }>>;
}

export interface StuckLog {
    warn(fields: Record<string, unknown>): void;
}

export interface StuckPass {
    items: StuckItem[];
    /** Sources this pass could not read. */
    unread: string[];
}

const keyOf = (i: StuckItem) => [i.subject, i.state, i.runId ?? i.setupKey ?? i.claimId ?? i.cellId ?? i.workflowId ?? i.environmentId ?? ''].join('|');

export class StuckDetector {
    private seen = new Set<string>();
    private last: StuckPass = { items: [], unread: [] };
    /** When this replica last ran a pass: only the replica holding the maintenance lock does, so another one's gauges go quiet. */
    private lastAt = 0;
    private claimCounts: Array<{ state: string; consumer: string; count: number }> = [];
    private admissionDepth: Array<{ kind: string; state: string; count: number; oldestMs: number }> = [];

    constructor(
        private readonly source: StuckSource,
        private readonly metrics: RuntimeMetrics,
        private readonly log: StuckLog,
        private readonly now: () => number = Date.now,
        /** How old a pass may be and still be exported (a few maintenance ticks). */
        private readonly freshMs = 120_000,
        /** The worker's queue limit (RUNTIME_QUEUE_TIMEOUT_MS): the queued bounds follow it. */
        private readonly queue: QueueLimit = {},
    ) {
        // A replica that stopped running the passes reports 0 for what it last saw (an observed gauge keeps its
        // last value otherwise): alert on the max over replicas.
        const quietIfStale = (points: Array<{ value: number; labels: Record<string, unknown> }>) => (this.fresh() ? points : points.map((p) => ({ ...p, value: 0 })));
        metrics.gauge(METRIC.stuckItems, () => quietIfStale((() => {
            const groups = new Map<string, { labels: Record<string, unknown>; value: number }>();
            for (const i of this.last.items) {
                const labels = { [ATTR.stuckSubject]: i.subject, [ATTR.stuckState]: i.state };
                const k = JSON.stringify(labels);
                groups.set(k, { labels, value: (groups.get(k)?.value ?? 0) + 1 });
            }
            return [...groups.values()];
        })()));
        metrics.gauge(METRIC.claimsOpen, () => quietIfStale(this.claimCounts.map((c) => ({ value: c.count, labels: { [ATTR.claimState]: c.state, [ATTR.claimConsumer]: c.consumer } }))));
        metrics.gauge(METRIC.admissionQueueDepth, () => quietIfStale(this.admissionDepth.map((a) => ({ value: a.count, labels: { kind: a.kind, state: a.state } }))));
        metrics.gauge(METRIC.admissionOldestWait, () => {
            const byKind = new Map<string, number>();
            for (const a of this.admissionDepth) byKind.set(a.kind, Math.max(byKind.get(a.kind) ?? 0, a.oldestMs));
            return quietIfStale([...byKind].map(([kind, value]) => ({ value, labels: { kind } })));
        });
    }

    private fresh(): boolean {
        return this.now() - this.lastAt <= this.freshMs;
    }

    /** The items of the last pass (the API reads its own; this is for tests and the worker's own use). */
    lastPass(): StuckPass {
        return this.last;
    }

    async pass(now: Date): Promise<StuckPass> {
        const unread: string[] = [];
        const read = async <T>(name: string, f: () => Promise<T[]>): Promise<T[]> => {
            try {
                return await f();
            } catch {
                unread.push(name);
                return [];
            }
        };
        const [runs, setups, claims, admissions, cells, workflows, counts] = await Promise.all([
            read('runs', () => this.source.runs()),
            read('setups', () => this.source.setups()),
            read('claims', () => this.source.claims()),
            read('admissions', () => this.source.admissions()),
            read('cells', () => this.source.cells()),
            read('workflows', () => this.source.workflows()),
            read('claim_counts', () => this.source.claimCounts()),
        ]);
        const items = [
            ...stuckRuns(runs, now, this.queue),
            ...stuckSetups(setups, now),
            ...stuckClaims(claims, now),
            ...stuckAdmissions(admissions, now),
            ...stuckCells(cells, now),
            ...stuckWorkflows(workflows, now, this.queue),
        ];
        const current = new Set<string>();
        for (const item of items) {
            const key = keyOf(item);
            current.add(key);
            if (this.seen.has(key)) continue;
            this.metrics.recordStuckDetected(item.subject);
            // Ids, the state and the numbers only: the typed event an operator alerts and searches on.
            this.log.warn({
                msg: 'runtime.stuck',
                [ATTR.stuckSubject]: item.subject,
                [ATTR.stuckState]: item.state,
                [ATTR.stuckAgeMs]: Math.round(item.ageMs),
                [ATTR.stuckBoundMs]: item.boundMs,
                since: item.since,
                ...(item.organizationId ? { [ATTR.organizationId]: item.organizationId } : {}),
                ...(item.runId ? { [ATTR.runId]: item.runId } : {}),
                ...(item.environmentId ? { [ATTR.environmentId]: item.environmentId } : {}),
                ...(item.setupKey ? { [ATTR.setupKey]: item.setupKey } : {}),
                ...(item.claimId ? { [ATTR.claimId]: item.claimId } : {}),
                ...(item.cellId ? { [ATTR.cellId]: item.cellId } : {}),
                ...(item.consumer ? { [ATTR.claimConsumer]: item.consumer } : {}),
                ...(item.workflowId ? { workflowId: item.workflowId } : {}),
            });
        }
        // An item that left its state is forgotten: if it comes back, it is reported again.
        this.seen = current;
        if (!unread.includes('claim_counts')) this.claimCounts = counts;
        if (!unread.includes('admissions')) {
            const depth = new Map<string, { kind: string; state: string; count: number; oldestMs: number }>();
            for (const a of admissions) {
                const k = `${a.kind}|${a.state}`;
                const age = now.getTime() - Date.parse(a.createdAt);
                const d = depth.get(k) ?? { kind: a.kind, state: a.state, count: 0, oldestMs: 0 };
                d.count++;
                d.oldestMs = Math.max(d.oldestMs, Number.isFinite(age) ? age : 0);
                depth.set(k, d);
            }
            this.admissionDepth = [...depth.values()];
        }
        this.last = { items, unread };
        this.lastAt = this.now();
        return this.last;
    }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const LIMIT = 2_000;

/** The runtime-worker's reads for the detector: the Runtime Postgres (owner role) and DBOS's public status API. */
export class PgStuckSource implements StuckSource {
    constructor(
        private readonly pool: Pool,
        private readonly liveRuns: () => Promise<RunRow[]>,
        private readonly listWorkflows: () => Promise<WorkflowRowView[]>,
    ) {}

    runs() {
        return this.liveRuns();
    }

    async setups(): Promise<SetupRow[]> {
        const r = await this.pool.query(
            `SELECT environment_id, organization_id, setup_key, state, requested_at, updated_at FROM runtime.runtime_environment_setups WHERE state = 'setting_up' LIMIT ${LIMIT}`,
        );
        return r.rows.map((x) => ({ environmentId: x.environment_id, organizationId: x.organization_id, setupKey: x.setup_key, state: x.state, requestedAt: iso(x.requested_at)!, updatedAt: iso(x.updated_at)! }));
    }

    async claims(): Promise<ClaimRowView[]> {
        const r = await this.pool.query(
            `SELECT claim_id, cell_id, org_id, run_id, environment_id, side, state, consumer, state_changed_at, created_at, hard_expires_at
               FROM runtime.runtime_claims WHERE state IN ('pending','bound','held','blocked','failed','compromised') ORDER BY hard_expires_at LIMIT ${LIMIT}`,
        );
        return r.rows.map((x) => ({
            claimId: x.claim_id, cellId: x.cell_id, orgId: x.org_id, runId: x.run_id, environmentId: x.environment_id, side: x.side, state: x.state,
            consumer: x.consumer, stateChangedAt: iso(x.state_changed_at), createdAt: iso(x.created_at), hardExpiresAt: iso(x.hard_expires_at)!,
        }));
    }

    async claimCounts() {
        const r = await this.pool.query(
            `SELECT state, COALESCE(consumer, 'runtime') AS consumer, count(*)::int AS n FROM runtime.runtime_claims
              WHERE state IN ('pending','bound','held','blocked','failed','compromised') GROUP BY 1, 2`,
        );
        return r.rows.map((x) => ({ state: x.state as string, consumer: x.consumer as string, count: Number(x.n) }));
    }

    async admissions(): Promise<AdmissionRowView[]> {
        const r = await this.pool.query(
            `SELECT org_id, kind, request_key, state, deadline_at, approval_deadline_at, created_at FROM runtime.runtime_admission_requests
              WHERE state IN ('awaiting_approval','waiting','owned','reserved','dispatched') ORDER BY created_at LIMIT ${LIMIT}`,
        );
        return r.rows.map((x) => ({ organizationId: x.org_id, kind: x.kind, key: x.request_key, state: x.state, deadlineAt: iso(x.deadline_at), approvalDeadlineAt: iso(x.approval_deadline_at), createdAt: iso(x.created_at)! }));
    }

    async cells(): Promise<CellSessionView[]> {
        const r = await this.pool.query(`SELECT cell_id, org_id, last_heartbeat_at, disconnected_at FROM runtime.runtime_cell_sessions WHERE disconnected_at IS NULL LIMIT ${LIMIT}`);
        return r.rows.map((x) => ({ cellId: x.cell_id, orgId: x.org_id, lastHeartbeatAt: iso(x.last_heartbeat_at)!, disconnectedAt: null }));
    }

    workflows() {
        return this.listWorkflows();
    }
}
