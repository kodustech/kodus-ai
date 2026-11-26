/**
 * A single-connection DataSource on the local Postgres for
 * *.integration.spec.ts files, or undefined when Postgres is not reachable
 * locally (the spec then skips). In CI, where the job starts Postgres, an
 * unreachable one fails the spec, as does any other setup error.
 */
require('dotenv').config();

import { DataSource, DataSourceOptions } from 'typeorm';

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

export const isUnreachable = (error: unknown): boolean => {
    const { code, message, errors } = (error ?? {}) as {
        code?: string;
        message?: string;
        errors?: unknown[];
    };
    if (code && UNREACHABLE.has(code)) return true;
    // Node reports a refused dual-stack connect as an AggregateError.
    if (Array.isArray(errors) && errors.some(isUnreachable)) return true;
    // pg's own connect timeout and dropped-connection errors carry no code.
    return (
        !code && /timeout expired|Connection terminated/i.test(message ?? '')
    );
};

export const skipPostgresIntegration = process.env.SKIP_INTEGRATION === 'true';

/**
 * Connects, and with `replica` set lets rows reference throwaway users,
 * teams and connections (foreign keys are not checked on this session).
 */
export async function connectTestPostgres(options?: {
    replica?: boolean;
    /** Models a spec reads through TypeORM repositories. */
    entities?: DataSourceOptions['entities'];
}): Promise<DataSource | undefined> {
    const candidate = new DataSource({
        type: 'postgres',
        host: process.env.TEST_PG_HOST ?? 'localhost',
        port: parseInt(
            process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
            10,
        ),
        username:
            process.env.TEST_PG_USER ??
            process.env.API_PG_DB_USERNAME ??
            'kodusdev',
        password:
            process.env.TEST_PG_PASSWORD ??
            process.env.API_PG_DB_PASSWORD ??
            'kodusdev',
        database:
            process.env.TEST_PG_DB ??
            process.env.API_PG_DB_DATABASE ??
            'kodus_db',
        logging: false,
        synchronize: false,
        entities: options?.entities ?? [],
        // One connection: a session setting covers every query.
        extra: { max: 1, min: 1, connectionTimeoutMillis: 10_000 },
    });
    try {
        await candidate.initialize();
    } catch (error) {
        await candidate.destroy().catch(() => undefined);
        if (!isUnreachable(error) || process.env.CI) throw error;
        return undefined;
    }
    if (options?.replica) {
        await candidate.query(`SET session_replication_role = replica`);
    }
    return candidate;
}

export async function disconnectTestPostgres(ds?: DataSource): Promise<void> {
    if (!ds) return;
    await ds.query(`SET session_replication_role = DEFAULT`);
    await ds.destroy();
}
