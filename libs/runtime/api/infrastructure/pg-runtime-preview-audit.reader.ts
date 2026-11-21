import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { PreviewAuditRecord, RuntimePreviewAuditReader } from '../domain/previews';

const QUERY_TIMEOUT_MS = 10_000;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);
const count = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

/**
 * The owner's preview activity (docs/runtime/preview-urls.md §6.7) from the
 * Runtime Postgres, read-only: runtime_preview_audit on
 * runtime_preview_audit_org_at_idx (or _preview_idx for one preview), every
 * read org-scoped and bounded. The table holds ids, actions and counts only.
 */
export class PgRuntimePreviewAuditReader implements RuntimePreviewAuditReader {
    constructor(private readonly db: SqlQuery) {}

    async list(input: { organizationId: string; limit: number; before?: string; previewId?: string }): Promise<PreviewAuditRecord[]> {
        const r = await this.db.query(
            `SELECT at, org_id, preview_id, run_id, side, actor, action, reason, requests, bytes_in, bytes_out
               FROM runtime.runtime_preview_audit
              WHERE org_id = $1 AND ($2::timestamptz IS NULL OR at < $2) AND ($3::text IS NULL OR preview_id = $3)
              ORDER BY at DESC, id DESC
              LIMIT $4`,
            [input.organizationId, input.before ?? null, input.previewId ?? null, input.limit],
            { timeoutMs: QUERY_TIMEOUT_MS },
        );
        return r.rows.map((x) => {
            const row: PreviewAuditRecord = { at: iso(x.at)!, organizationId: x.org_id, previewId: x.preview_id, action: x.action };
            const extra: Partial<PreviewAuditRecord> = {
                runId: x.run_id ?? undefined,
                side: x.side === 'pr' || x.side === 'base' ? x.side : undefined,
                actor: x.actor ?? undefined,
                reason: x.reason ?? undefined,
                requests: count(x.requests),
                bytesIn: count(x.bytes_in),
                bytesOut: count(x.bytes_out),
            };
            for (const [k, v] of Object.entries(extra)) if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v;
            return row;
        });
    }

    async sessionsOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<number> {
        const r = await this.db.query(
            `SELECT count(*)::int AS n FROM runtime.runtime_preview_audit WHERE org_id = $1 AND at >= $2 AND at < $3 AND action = 'session_opened'`,
            [organizationId, window.start, window.end],
            { timeoutMs: QUERY_TIMEOUT_MS },
        );
        return Number(r.rows[0]?.n ?? 0);
    }
}
