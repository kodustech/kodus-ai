import { Pool } from 'pg';

import type { RunStreamPage } from '@libs/runtime/run';
import { FileRunStreamStore } from '@libs/runtime/run/adapters/file-run-stream.store';
import { PgRunStreamStore } from '@libs/runtime/run/adapters/pg-run-stream.store';

/**
 * Reads one Run's stream where the hub wrote it, for the e2e scripts:
 * RUNTIME_STREAM_STORE=postgres (the default) reads the Runtime Postgres
 * (RUNTIME_DATABASE_READ_URL, else RUNTIME_DATABASE_URL); file reads RUNTIME_STREAM_DIR.
 */
export async function readRunStreamForE2e(organizationId: string, runId: string, env: NodeJS.ProcessEnv = process.env): Promise<RunStreamPage | null> {
    if (env.RUNTIME_STREAM_STORE === 'file') return new FileRunStreamStore(env.RUNTIME_STREAM_DIR ?? './.runtime-data/streams').read(organizationId, runId);
    const pool = new Pool({ connectionString: env.RUNTIME_DATABASE_READ_URL || env.RUNTIME_DATABASE_URL || 'postgres://runtime:runtime@localhost:5442/kodus_runtime', max: 1 });
    try {
        return await new PgRunStreamStore(pool).read(organizationId, runId);
    } finally {
        await pool.end();
    }
}
