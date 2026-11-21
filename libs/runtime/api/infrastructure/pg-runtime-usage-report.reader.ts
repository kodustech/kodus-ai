import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { RuntimeUsageReportReader } from '../domain/ports';
import type { UsageClaimRecord, UsageReportFilters, UsageRunRecord } from '../domain/usage-report';

/** A report is read by an owner, rarely: a slow month still answers, a runaway one is cancelled by the server. */
const REPORT_QUERY_TIMEOUT_MS = 15_000;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** A side's boot phases as the cell reported them, names and durations only. */
function phasesOf(timing: unknown): Array<{ name: string; ms: number }> | undefined {
    const phases = (timing as { phases?: unknown } | null)?.phases;
    if (!Array.isArray(phases)) return undefined;
    const out = phases
        .map((p) => ({ name: typeof p?.name === 'string' ? p.name : '', ms: num(p?.ms) }))
        .filter((p): p is { name: string; ms: number } => !!p.name && p.ms !== null);
    return out.length ? out : undefined;
}

function phaseMsOf(v: unknown): { boot: number; apply: number } | null {
    const o = v as { boot?: unknown; apply?: unknown } | null;
    const boot = num(o?.boot);
    const apply = num(o?.apply);
    return boot !== null && apply !== null ? { boot, apply } : null;
}

/** The claim columns both claim reads select, the consumer of a row from before migration 7 inferred from its Run. */
const CLAIM_COLUMNS = `c.claim_id, c.cell_id, c.run_id, c.environment_id, c.side, c.state, c.driver, c.memory_mb_boot, c.memory_mb_ready,
    c.memory_allocatable_mb, c.cpus, c.start_source, c.admitted_at, c.ready_at, c.released_at, c.state_changed_at, c.hard_expires_at, c.created_at,
    COALESCE(c.consumer, CASE WHEN c.run_id IS NOT NULL THEN 'runtime' ELSE 'unknown' END) AS consumer`;

/** A claim row of CLAIM_COLUMNS (plus its repository_id) as the report reads it. */
function claimRecordOf(r: any): UsageClaimRecord {
    return {
        claimId: r.claim_id,
        cellId: r.cell_id,
        runId: r.run_id ?? null,
        environmentId: r.environment_id ?? null,
        side: r.side,
        state: r.state,
        consumer: r.consumer,
        repositoryId: r.repository_id ?? null,
        driver: r.driver ?? null,
        bootMb: r.memory_mb_boot ?? null,
        readyMb: r.memory_mb_ready ?? null,
        allocatableMb: r.memory_allocatable_mb ?? null,
        cpus: r.cpus ?? null,
        start: r.start_source === 'cold' || r.start_source === 'pool' || r.start_source === 'bake' ? r.start_source : null,
        admittedAt: iso(r.admitted_at),
        readyAt: iso(r.ready_at),
        releasedAt: iso(r.released_at),
        stateChangedAt: iso(r.state_changed_at),
        hardExpiresAt: iso(r.hard_expires_at),
        createdAt: iso(r.created_at)!,
    };
}

/**
 * The usage report's rows from the Runtime Postgres (RuntimeReadDb: the
 * read-only URL, every query inside BEGIN READ ONLY). Runs on
 * runtime_runs_org_requested_idx (or its repository and environment
 * siblings); the Runs' claims on runtime_claims_run_idx; the other claims on
 * runtime_claims_org_created_idx (migration 23); the sandbox operations on
 * runtime_sandbox_audit_org_at_idx. Every read is org-scoped and bounded.
 */
export class PgRuntimeUsageReportReader implements RuntimeUsageReportReader {
    /**
     * `db` carries the report's reads (up to 15 s, the reports' pool);
     * `screens` the one a screen waits on (Preview settings): an indexed
     * month of preview claims that must not queue behind the reports.
     */
    constructor(
        private readonly db: SqlQuery,
        private readonly screens: SqlQuery = db,
    ) {}

    async runsOfMonth(organizationId: string, window: { start: Date; end: Date }, filters: UsageReportFilters, limit: number) {
        const where = `r.organization_id = $1 AND r.requested_at >= $2 AND r.requested_at < $3
            AND ($4::text IS NULL OR r.repository_id = $4) AND ($5::text IS NULL OR r.environment_id = $5)`;
        const values = [organizationId, window.start, window.end, filters.repositoryId ?? null, filters.environmentId ?? null];
        const [rows, count] = await Promise.all([
            this.db.query(
                `SELECT r.run_id, r.organization_id, r.repository_id, r.repository_name, r.environment_id, r.pr_number, r.trigger, r.state,
                        r.verdict_state, r.requested_at, r.started_at, r.finished_at,
                        r.report->>'bootingAt' AS booting_at, r.report->>'cellOwner' AS cell_owner, r.report->'bootMs' AS boot_ms,
                        r.report->'phaseMs' AS phase_ms, r.report->'capacityWaitMs' AS capacity_wait_ms,
                        r.report->'bootTiming'->'base' AS base_timing, r.report->'bootTiming'->'pr' AS pr_timing
                   FROM runtime.runtime_runs r
                  WHERE ${where}
                  ORDER BY r.requested_at DESC
                  LIMIT $6`,
                [...values, limit],
                { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
            ),
            this.db.query(`SELECT count(*)::int AS n FROM runtime.runtime_runs r WHERE ${where}`, values, { timeoutMs: REPORT_QUERY_TIMEOUT_MS }),
        ]);
        const runs: UsageRunRecord[] = rows.rows.map((r) => {
            const base = phasesOf(r.base_timing);
            const pr = phasesOf(r.pr_timing);
            return {
                runId: r.run_id,
                organizationId: r.organization_id,
                repositoryId: r.repository_id ?? null,
                repositoryName: r.repository_name ?? null,
                environmentId: r.environment_id ?? null,
                prNumber: r.pr_number ?? null,
                trigger: r.trigger ?? null,
                state: r.state,
                verdictState: r.verdict_state ?? null,
                requestedAt: iso(r.requested_at)!,
                startedAt: iso(r.started_at),
                bootingAt: iso(r.booting_at),
                finishedAt: iso(r.finished_at),
                cellOwner: r.cell_owner === 'customer' ? 'customer' : r.cell_owner === 'kodus' ? 'kodus' : null,
                bootMs: num(r.boot_ms),
                phaseMs: phaseMsOf(r.phase_ms),
                bootPhases: { ...(base ? { base } : {}), ...(pr ? { pr } : {}) },
                capacityWaitMs: num(r.capacity_wait_ms),
            };
        });
        return { runs, total: Number(count.rows[0]?.n ?? 0) };
    }

    async claimsOfMonth(organizationId: string, window: { start: Date; end: Date }, filters: UsageReportFilters, limit: number) {
        const repo = filters.repositoryId ?? null;
        const env = filters.environmentId ?? null;
        const [ofRuns, others] = await Promise.all([
            // The Runs' claims belong to the Run's month, whenever the claim was made.
            this.db.query(
                `SELECT ${CLAIM_COLUMNS}, r.repository_id
                   FROM runtime.runtime_runs r
                   JOIN runtime.runtime_claims c ON c.run_id = r.run_id AND c.org_id = r.organization_id
                  WHERE r.organization_id = $1 AND r.requested_at >= $2 AND r.requested_at < $3
                    AND ($4::text IS NULL OR r.repository_id = $4) AND ($5::text IS NULL OR r.environment_id = $5)
                  ORDER BY c.created_at
                  LIMIT $6`,
                [organizationId, window.start, window.end, repo, env, limit + 1],
                { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
            ),
            // Setups, sandbox sessions, MCP and custom agents: by when the claim was made. Their repository is
            // the environment's (its setup row); a sandbox serves none, so a repository filter leaves it out.
            this.db.query(
                `SELECT ${CLAIM_COLUMNS}, s.repository_id
                   FROM runtime.runtime_claims c
                   LEFT JOIN runtime.runtime_environment_setups s ON s.environment_id = c.environment_id AND s.organization_id = c.org_id
                  WHERE c.org_id = $1 AND c.created_at >= $2 AND c.created_at < $3
                    AND COALESCE(c.consumer, CASE WHEN c.run_id IS NOT NULL THEN 'runtime' ELSE 'unknown' END) <> 'runtime'
                    AND ($4::text IS NULL OR s.repository_id = $4) AND ($5::text IS NULL OR c.environment_id = $5)
                  ORDER BY c.created_at
                  LIMIT $6`,
                [organizationId, window.start, window.end, repo, env, limit + 1],
                { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
            ),
        ]);
        const truncated = ofRuns.rows.length > limit || others.rows.length > limit;
        const claims: UsageClaimRecord[] = [...ofRuns.rows.slice(0, limit), ...others.rows.slice(0, limit)].map(claimRecordOf);
        return { claims, truncated };
    }

    /**
     * The org's preview claims created in the window, on the partial runtime_claims_org_preview_idx (migration
     * 43): only previews, never the month's every claim (sandbox claims of code review dominate it).
     */
    async previewClaimsOfMonth(organizationId: string, window: { start: Date; end: Date }, limit: number) {
        const r = await this.screens.query(
            `SELECT ${CLAIM_COLUMNS}, NULL::text AS repository_id
               FROM runtime.runtime_claims c
              WHERE c.org_id = $1 AND c.consumer = 'preview' AND c.created_at >= $2 AND c.created_at < $3
              ORDER BY c.created_at
              LIMIT $4`,
            [organizationId, window.start, window.end, limit + 1],
            { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
        );
        return { claims: r.rows.slice(0, limit).map(claimRecordOf), truncated: r.rows.length > limit };
    }

    /** On runtime_sandbox_audit_org_at_idx (migration 22); needs the reader's grant on the table (runtime-reader-grants.sql). */
    async sandboxOperationsOfMonth(organizationId: string, window: { start: Date; end: Date }) {
        const r = await this.db.query(
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE outcome = 'refused')::int AS refused,
                    count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
                    COALESCE(sum(duration_ms), 0)::bigint AS duration_ms
               FROM runtime.runtime_sandbox_audit
              WHERE org_id = $1 AND at >= $2 AND at < $3`,
            [organizationId, window.start, window.end],
            { timeoutMs: REPORT_QUERY_TIMEOUT_MS },
        );
        const row = r.rows[0] ?? {};
        return { total: num(row.total) ?? 0, refused: num(row.refused) ?? 0, failed: num(row.failed) ?? 0, durationMs: num(row.duration_ms) ?? 0 };
    }
}
