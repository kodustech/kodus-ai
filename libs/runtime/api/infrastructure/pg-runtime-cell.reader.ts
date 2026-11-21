import type { QueryResultRow } from 'pg';

import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { RuntimeCell, RuntimeCellReader, SandboxCellFactsReader, SandboxCellFactsRow, RuntimeCellTokenReader, RuntimeCellTokenRow } from '../domain/ports';

interface CellRow extends QueryResultRow {
    cell_id: string;
    organization_id: string | null;
    owner: 'kodus' | 'customer';
    topology: RuntimeCell['topology'];
    status: RuntimeCell['status'];
    certificate_serial: string | null;
    certificate_expires_at: Date | null;
    last_heartbeat_at: Date | null;
    created_at: Date | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : undefined);

const toCell = (r: CellRow): RuntimeCell => ({
    cellId: r.cell_id,
    organizationId: r.organization_id,
    owner: r.owner,
    topology: r.topology,
    status: r.status,
    certificateSerial: r.certificate_serial ?? undefined,
    certificateExpiresAt: iso(r.certificate_expires_at),
    lastHeartbeatAt: iso(r.last_heartbeat_at),
    registeredAt: iso(r.created_at),
});

const COLUMNS =
    'cell_id, organization_id, owner, topology, status, certificate_serial, certificate_expires_at, last_heartbeat_at, created_at';

/**
 * A reader of the Runtime Postgres through the shared read-only RuntimeReadDb
 * (ADR-025: the API reads the Runtime database, never writes it). Without
 * RUNTIME_DATABASE_READ_URL a read fails with 503, as every Runtime read does.
 */
abstract class PgRuntimeReadOnly {
    constructor(private readonly db: SqlQuery) {}

    protected async query<R extends QueryResultRow>(sql: string, params: unknown[]): Promise<R[]> {
        return (await this.db.query(sql, params)).rows as R[];
    }
}

/** Reads `runtime_cells` from the Runtime Postgres with a read-only user. */
export class PgRuntimeCellReader extends PgRuntimeReadOnly implements RuntimeCellReader {
    async listByOrganization(organizationId: string) {
        const rows = await this.query<CellRow>(
            `SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [organizationId],
        );
        return rows.map(toCell);
    }

    async listManaged() {
        const rows = await this.query<CellRow>(
            `SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE owner = 'kodus' AND status <> 'revoked' ORDER BY created_at DESC LIMIT 200`,
            [],
        );
        return rows.map(toCell);
    }

    async get(cellId: string) {
        const rows = await this.query<CellRow>(`SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE cell_id = $1`, [cellId]);
        return rows[0] ? toCell(rows[0]) : null;
    }
}

interface TokenRow extends QueryResultRow {
    token_hash: string;
    organization_id: string;
    topology: RuntimeCellTokenRow['topology'];
    issued_by: string;
    created_at: Date;
    expires_at: Date;
    used_at: Date | null;
    revoked_at: Date | null;
}

const toToken = (r: TokenRow): RuntimeCellTokenRow => ({
    tokenHash: r.token_hash,
    organizationId: r.organization_id,
    topology: r.topology,
    issuedBy: r.issued_by,
    issuedAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
    ...(r.used_at ? { usedAt: iso(r.used_at) } : {}),
    ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}),
});

const TOKEN_COLUMNS = 'token_hash, organization_id, topology, issued_by, created_at, expires_at, used_at, revoked_at';

/** Reads `runtime_cell_tokens` (hashes only; the token is never stored) with the same read-only user. */
export class PgRuntimeCellTokenReader extends PgRuntimeReadOnly implements RuntimeCellTokenReader {
    async listByOrganization(organizationId: string, since: Date) {
        const rows = await this.query<TokenRow>(
            `SELECT ${TOKEN_COLUMNS} FROM runtime.runtime_cell_tokens WHERE organization_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 100`,
            [organizationId, since],
        );
        return rows.map(toToken);
    }

    async get(tokenHash: string) {
        const rows = await this.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM runtime.runtime_cell_tokens WHERE token_hash = $1`, [tokenHash]);
        return rows[0] ? toToken(rows[0]) : null;
    }
}

/** The sandbox size and heartbeat memory of this install's live cells, read-only (the hub writes them). */
export class PgSandboxCellFactsReader extends PgRuntimeReadOnly implements SandboxCellFactsReader {
    async liveCells(): Promise<SandboxCellFactsRow[]> {
        const rows = await this.query<{ cell_id: string; memory_allocatable_mb: number | null; sandbox_claim_memory_mb: number | null; sandbox_claim_cpus: number | null; sandbox_pool_target: number | null; sandbox_pool_ready: number | null }>(
            `SELECT cell_id, memory_allocatable_mb, sandbox_claim_memory_mb, sandbox_claim_cpus,
                    sandbox_pool_target, sandbox_pool_ready
               FROM runtime.runtime_cell_sessions
              WHERE owner <> 'kodus' AND disconnected_at IS NULL AND last_heartbeat_at > now() - interval '2 minutes'
              ORDER BY cell_id LIMIT 200`,
            [],
        );
        return rows.map((r) => ({
            cellId: r.cell_id,
            allocatableMb: r.memory_allocatable_mb,
            sandboxMemoryMb: r.sandbox_claim_memory_mb,
            sandboxCpus: r.sandbox_claim_cpus,
            poolTarget: r.sandbox_pool_target,
            poolReady: r.sandbox_pool_ready,
        }));
    }
}
