import type { Pool } from 'pg';

import { QUEUE_BATCH_MAX_SPECS, QUEUE_BATCH_TARGET_MS, QUEUE_LEASE_MS, QUEUE_MAX_ATTEMPTS, type QueueEntry } from '@libs/runtime/suite';

/**
 * runtime.runtime_suite_queue (docs/runtime/e2e-suites.md section 6, dynamic queue): the specs of one suite run that no shard has
 * finished. The shards of the run pull the next spec, or a small batch, with one conditional UPDATE (a spec is `queued` or it is not,
 * so two shards never get one spec); a claim is a lease that the shard renews while its command is polled, and a lapsed lease sends
 * the spec back to the queue while it has attempts left (a shard that lost its host or died), else it is `abandoned` and the engine
 * reports it `infra` for the fresh host. Every read and write names the organization. The caller gives `now` (the engine's clock),
 * so a lease is judged by one clock, never by each database session's.
 */
export type QueueState = 'queued' | 'claimed' | 'done' | 'abandoned';

export interface QueueCounts {
    queued: number;
    claimed: number;
    done: number;
    abandoned: number;
}

export interface QueueLeftover {
    spec: string;
    state: Exclude<QueueState, 'done'>;
    /** The shard that last held it (a claimed or abandoned spec). */
    claimedBy?: number;
}

export interface LostClaims {
    requeued: string[];
    abandoned: string[];
}

export interface ClaimRequest {
    organizationId: string;
    suiteRunId: string;
    shard: number;
    now: Date;
    leaseMs?: number;
    /** The estimated work one pull takes (`QUEUE_BATCH_TARGET_MS`); the head spec is always taken. */
    targetMs?: number;
    maxSpecs?: number;
}

/** Pulls that came back empty only because a sibling's pull held the same rows are repeated this many times before the queue is taken to be empty. */
const CONTENTION_RETRIES = 5;

export class PgSuiteQueue {
    constructor(private readonly pool: Pick<Pool, 'query'>) {}

    /** Puts the run's specs in the queue; a run asked again (a replay) adds nothing. Returns how many were added. */
    async seed(organizationId: string, suiteRunId: string, entries: readonly QueueEntry[]): Promise<number> {
        if (entries.length === 0) return 0;
        const r = await this.pool.query(
            `INSERT INTO runtime.runtime_suite_queue (suite_run_id, spec, organization_id, priority, weight, est_ms)
             SELECT $1, e.spec, $2, e.priority, e.weight, e.est_ms
               FROM unnest($3::text[], $4::smallint[], $5::bigint[], $6::bigint[]) AS e(spec, priority, weight, est_ms)
             ON CONFLICT (suite_run_id, spec) DO NOTHING`,
            [suiteRunId, organizationId, entries.map((e) => e.spec), entries.map((e) => e.priority), entries.map((e) => e.weight), entries.map((e) => e.estMs ?? null)],
        );
        return r.rowCount ?? 0;
    }

    /**
     * The next specs for `shard`, in the order of the queue, about `targetMs` of estimated work (the first is always taken, so a
     * long spec goes alone). One statement: the rows are picked, and updated only while they are still `queued`, so concurrent pulls
     * never share a spec, and rows a sibling's pull holds are skipped, not waited for. A pull that finds every queued row held by siblings
     * asks again, so an empty answer means an empty queue.
     */
    async claimNext(c: ClaimRequest): Promise<string[]> {
        const lease = c.leaseMs ?? QUEUE_LEASE_MS;
        for (let attempt = 0; attempt <= CONTENTION_RETRIES; attempt++) {
            const r = await this.pool.query(
                `WITH head AS (
                   SELECT spec, priority, weight, est_ms
                     FROM runtime.runtime_suite_queue
                    WHERE organization_id = $1 AND suite_run_id = $2 AND state = 'queued'
                    ORDER BY priority, weight DESC, spec
                    LIMIT $7::int
                      FOR UPDATE SKIP LOCKED),
                 cand AS (
                   SELECT spec, priority, weight,
                          COALESCE(sum(COALESCE(est_ms, $6::bigint)) OVER (ORDER BY priority, weight DESC, spec ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_ms
                     FROM head),
                 pick AS (SELECT spec FROM cand WHERE before_ms < $6::bigint)
                 UPDATE runtime.runtime_suite_queue q
                    SET state = 'claimed', claimed_by = $3, claimed_at = $4::timestamptz, attempts = q.attempts + 1,
                        lease_expires_at = $4::timestamptz + ($5::double precision * interval '1 millisecond')
                  WHERE q.organization_id = $1 AND q.suite_run_id = $2 AND q.state = 'queued' AND q.spec IN (SELECT spec FROM pick)
                  RETURNING q.spec, q.priority, q.weight`,
                [c.organizationId, c.suiteRunId, c.shard, c.now, lease, c.targetMs ?? QUEUE_BATCH_TARGET_MS, c.maxSpecs ?? QUEUE_BATCH_MAX_SPECS],
            );
            if (r.rows.length > 0) {
                return (r.rows as Array<{ spec: string; priority: number; weight: string | number }>)
                    .sort((a, b) => a.priority - b.priority || Number(b.weight) - Number(a.weight) || (a.spec < b.spec ? -1 : 1))
                    .map((x) => x.spec);
            }
            if ((await this.counts(c.organizationId, c.suiteRunId)).queued === 0) return [];
        }
        return [];
    }

    /** The shard is alive: every spec it holds keeps its lease for another `leaseMs`. */
    async renew(organizationId: string, suiteRunId: string, shard: number, now: Date, leaseMs: number = QUEUE_LEASE_MS): Promise<void> {
        await this.pool.query(
            `UPDATE runtime.runtime_suite_queue SET lease_expires_at = $4::timestamptz + ($5::double precision * interval '1 millisecond')
              WHERE organization_id = $1 AND suite_run_id = $2 AND state = 'claimed' AND claimed_by = $3`,
            [organizationId, suiteRunId, shard, now, leaseMs],
        );
    }

    /** The specs have a result (or ended for good, `not_run`): they leave the queue, whoever holds them now. */
    async complete(organizationId: string, suiteRunId: string, specs: readonly string[], now: Date): Promise<void> {
        if (specs.length === 0) return;
        await this.pool.query(
            `UPDATE runtime.runtime_suite_queue SET state = 'done', finished_at = $4::timestamptz, lease_expires_at = NULL
              WHERE organization_id = $1 AND suite_run_id = $2 AND spec = ANY($3::text[]) AND state IN ('claimed', 'queued')`,
            [organizationId, suiteRunId, [...specs], now],
        );
    }

    /** The shard lost its host or died: its unfinished specs (the ones named, else all it holds) go back to the queue, or are abandoned past their attempts. */
    async release(organizationId: string, suiteRunId: string, shard: number, now: Date, specs?: readonly string[]): Promise<LostClaims> {
        return this.lose(`claimed_by = $4 AND ($5::text[] IS NULL OR spec = ANY($5::text[]))`, [organizationId, suiteRunId, now, shard, specs ? [...specs] : null]);
    }

    /** The claims whose lease ran out at `now`: a shard that stopped renewing is taken to be dead. */
    async requeueExpired(organizationId: string, suiteRunId: string, now: Date): Promise<LostClaims> {
        return this.lose(`lease_expires_at <= $3::timestamptz`, [organizationId, suiteRunId, now]);
    }

    private async lose(where: string, params: unknown[]): Promise<LostClaims> {
        const r = await this.pool.query(
            `UPDATE runtime.runtime_suite_queue
                SET state = CASE WHEN attempts < ${QUEUE_MAX_ATTEMPTS} THEN 'queued' ELSE 'abandoned' END,
                    claimed_by = CASE WHEN attempts < ${QUEUE_MAX_ATTEMPTS} THEN NULL ELSE claimed_by END,
                    lease_expires_at = NULL,
                    finished_at = CASE WHEN attempts < ${QUEUE_MAX_ATTEMPTS} THEN NULL ELSE $3::timestamptz END
              WHERE organization_id = $1 AND suite_run_id = $2 AND state = 'claimed' AND ${where}
              RETURNING spec, state`,
            params,
        );
        const rows = r.rows as Array<{ spec: string; state: string }>;
        return { requeued: rows.filter((x) => x.state === 'queued').map((x) => x.spec), abandoned: rows.filter((x) => x.state === 'abandoned').map((x) => x.spec) };
    }

    async counts(organizationId: string, suiteRunId: string): Promise<QueueCounts> {
        const r = await this.pool.query(`SELECT state, count(*)::int AS n FROM runtime.runtime_suite_queue WHERE organization_id = $1 AND suite_run_id = $2 GROUP BY state`, [organizationId, suiteRunId]);
        const out: QueueCounts = { queued: 0, claimed: 0, done: 0, abandoned: 0 };
        for (const row of r.rows as Array<{ state: QueueState; n: number }>) out[row.state] = row.n;
        return out;
    }

    /** What is not done: specs nobody took, claims nobody finished, abandoned ones. The engine gives each its place in the run's result. */
    async leftovers(organizationId: string, suiteRunId: string): Promise<QueueLeftover[]> {
        const r = await this.pool.query(
            `SELECT spec, state, claimed_by FROM runtime.runtime_suite_queue WHERE organization_id = $1 AND suite_run_id = $2 AND state <> 'done' ORDER BY priority, weight DESC, spec`,
            [organizationId, suiteRunId],
        );
        return (r.rows as Array<{ spec: string; state: QueueLeftover['state']; claimed_by: number | null }>).map((x) => ({ spec: x.spec, state: x.state, ...(x.claimed_by !== null ? { claimedBy: x.claimed_by } : {}) }));
    }
}
