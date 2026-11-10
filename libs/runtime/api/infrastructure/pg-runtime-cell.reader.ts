import { ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';

import type { RuntimeCell, RuntimeCellReader } from '../domain/ports';

interface CellRow {
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
 * Reads `runtime_cells` from the Runtime Postgres with a read-only user
 * (ADR-025: the API reads the Runtime database, never writes it).
 */
export class PgRuntimeCellReader implements RuntimeCellReader {
    private pool?: Pool;

    constructor(private readonly url: string | undefined) {}

    private db(): Pool {
        if (!this.url) throw new ServiceUnavailableException('Runtime database is not configured (RUNTIME_DATABASE_READ_URL, a read-only user)');
        this.pool ??= new Pool({ connectionString: this.url, max: 2, idleTimeoutMillis: 30_000 });
        return this.pool;
    }

    private async query(sql: string, params: unknown[]): Promise<CellRow[]> {
        const client = await this.db().connect();
        try {
            await client.query('BEGIN READ ONLY');
            const res = await client.query<CellRow>(sql, params);
            await client.query('COMMIT');
            return res.rows;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
    }

    async listByOrganization(organizationId: string) {
        const rows = await this.query(
            `SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [organizationId],
        );
        return rows.map(toCell);
    }

    async listManaged() {
        const rows = await this.query(
            `SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE owner = 'kodus' AND status <> 'revoked' ORDER BY created_at DESC LIMIT 200`,
            [],
        );
        return rows.map(toCell);
    }

    async get(cellId: string) {
        const rows = await this.query(`SELECT ${COLUMNS} FROM runtime.runtime_cells WHERE cell_id = $1`, [cellId]);
        return rows[0] ? toCell(rows[0]) : null;
    }

    async onModuleDestroy() {
        await this.pool?.end();
    }
}
