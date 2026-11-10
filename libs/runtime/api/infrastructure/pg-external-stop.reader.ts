import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import type { ExternalStopReader } from '../domain/external-findings';

/** Stop state is read from the Runtime database using the dedicated read-only connection. */
export class PgExternalStopReader implements ExternalStopReader {
    private pool?: Pool;
    private readonly log = new Logger(PgExternalStopReader.name);
    constructor(private readonly url: string | undefined) {}
    async isStopped(organizationId: string): Promise<boolean> {
        if (!this.url)
            throw new Error('Runtime stop state reader is unavailable');
        if (!this.pool) {
            this.pool = new Pool({
                connectionString: this.url,
                max: 2,
                idleTimeoutMillis: 30_000,
                connectionTimeoutMillis: 5_000,
            });
            // pg removes a broken idle client before emitting; handle the pool event
            // so an independent Runtime database outage cannot crash the API.
            this.pool.on('error', () =>
                this.log.warn({
                    event: 'runtime.a2a.stop_reader_unavailable',
                    reason: 'idle_connection_error',
                }),
            );
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query("SET LOCAL statement_timeout='5s'");
            const result = await client.query(
                `SELECT 1 FROM runtime.runtime_stops WHERE cleared_at IS NULL AND (scope='global' OR organization_id=$1) LIMIT 1`,
                [organizationId],
            );
            await client.query('COMMIT');
            return result.rows.length > 0;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            client.release();
        }
    }
    async onModuleDestroy() {
        await this.pool?.end();
    }
}
