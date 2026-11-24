import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

/**
 * Postgres connection settings that decide whether Kodus works behind a
 * connection pooler (PgBouncer, RDS Proxy, CloudNativePG Pooler).
 *
 * Two connections, by purpose:
 *   - pooled (DATABASE_URL / API_PG_DB_*): every runtime query. May point at
 *     a pooler in transaction mode: the runtime uses no session state.
 *   - direct (DATABASE_DIRECT_URL / API_PG_DB_DIRECT_HOST): what needs a real
 *     Postgres session — migrations (`SET statement_timeout`, `CREATE INDEX
 *     CONCURRENTLY`) and the LISTEN connection of the cross-process event
 *     bridge. Unset means "same as pooled", which is how every install
 *     without a pooler (Kodus cloud included) keeps working unchanged.
 *
 * Session timeouts travel in the startup packet. PgBouncer refuses unknown
 * startup parameters (`unsupported startup parameter: statement_timeout`)
 * unless it lists them in `track_extra_parameters`; setting a timeout to 0
 * stops Kodus from sending it, for poolers that cannot be configured.
 */

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export interface PostgresSessionTimeouts {
    statement_timeout?: number;
    idle_in_transaction_session_timeout?: number;
}

type Env = Record<string, string | undefined>;

/** docker-compose writes unset vars as empty strings: treat those as unset. */
/**
 * A database setting Kodus refuses. The message names the variable and
 * never carries a credential, so it is safe to show as is (logs, doctor).
 */
export class DatabaseSettingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DatabaseSettingError';
    }
}

function envValue(env: Env, key: string): string | undefined {
    const value = env[key];
    return value !== undefined && value.trim() !== ''
        ? value.trim()
        : undefined;
}

function readMilliseconds(env: Env, key: string, fallback: number): number {
    const raw = envValue(env, key);
    if (raw === undefined) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        throw new DatabaseSettingError(
            `${key} must be a whole number of milliseconds (0 turns it off), got "${raw}"`,
        );
    }
    return Number(raw);
}

/**
 * Per-connection timeouts for the app pools. A value of 0 leaves the
 * parameter out of the startup packet, so the server (or the pooler's
 * InitQuery / role default) decides.
 */
export function resolveSessionTimeouts(
    env: Env = process.env,
): PostgresSessionTimeouts {
    const statement = readMilliseconds(
        env,
        'DB_STATEMENT_TIMEOUT_MS',
        DEFAULT_STATEMENT_TIMEOUT_MS,
    );
    const idleInTransaction = readMilliseconds(
        env,
        'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
        DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    );

    return {
        ...(statement > 0 ? { statement_timeout: statement } : {}),
        ...(idleInTransaction > 0
            ? { idle_in_transaction_session_timeout: idleInTransaction }
            : {}),
    };
}

/** The pooled connection, as the app has always resolved it. */
export function resolvePooledConnection(
    env: Env = process.env,
): DatabaseConnection {
    const url = envValue(env, 'DATABASE_URL') ?? envValue(env, 'API_PG_DB_URL');
    if (url) {
        return { url };
    }

    const nodeEnv = env.API_DATABASE_ENV ?? env.API_NODE_ENV;
    return {
        host: ['homolog', 'production'].includes(nodeEnv ?? '')
            ? envValue(env, 'API_PG_DB_HOST')
            : (envValue(env, 'API_PG_DB_HOST') ?? 'localhost'),
        port: parseInt(env.API_PG_DB_PORT ?? '', 10),
        username: env.API_PG_DB_USERNAME,
        password: env.API_PG_DB_PASSWORD,
        database: env.API_PG_DB_DATABASE,
    };
}

/**
 * The direct connection, or undefined when none is configured.
 *
 * Lookup: DATABASE_DIRECT_URL → API_PG_DB_DIRECT_HOST
 * (+ API_PG_DB_DIRECT_PORT, default 5432). The host form reuses the pooled
 * credentials and database, so installs configured with discrete vars (the
 * Helm chart, the compose installer) only add a host. The port does NOT
 * follow the pooled one: that is usually the pooler's (6432), not Postgres's.
 */
export function resolveDirectConnection(
    env: Env = process.env,
): DatabaseConnection | undefined {
    const url = envValue(env, 'DATABASE_DIRECT_URL');
    if (url) {
        // A placeholder or a host:port here would only surface later as an
        // opaque connect failure in the migrations or the LISTEN client.
        if (!/^postgres(ql)?:\/\//i.test(url)) {
            throw new DatabaseSettingError(
                'DATABASE_DIRECT_URL must be a postgres:// connection string (or unset)',
            );
        }
        return { url };
    }

    const host = envValue(env, 'API_PG_DB_DIRECT_HOST');
    if (!host) {
        return undefined;
    }
    const port = envValue(env, 'API_PG_DB_DIRECT_PORT') ?? '5432';
    // URL's port setter ignores what it cannot parse, so a typo would keep
    // the pooler's port while logs and the doctor say "direct".
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw new DatabaseSettingError(
            'API_PG_DB_DIRECT_PORT must be a port number between 1 and 65535 (or unset for 5432)',
        );
    }
    const pooled = resolvePooledConnection(env);

    if (pooled.url) {
        let parsed: URL;
        try {
            parsed = new URL(pooled.url);
        } catch {
            throw new DatabaseSettingError(
                'API_PG_DB_DIRECT_HOST needs a parseable DATABASE_URL to borrow credentials from; set DATABASE_DIRECT_URL instead',
            );
        }
        parsed.hostname = host;
        parsed.port = port;
        return { url: parsed.toString() };
    }

    return {
        ...pooled,
        host,
        port: parseInt(port, 10),
    };
}

/** Direct when configured, pooled otherwise. */
export function resolveSessionConnection(
    env: Env = process.env,
): DatabaseConnection {
    return resolveDirectConnection(env) ?? resolvePooledConnection(env);
}

/** `host:port/database`, never credentials — for logs and the doctor. */
export function describeConnection(connection: DatabaseConnection): string {
    if (connection.url) {
        try {
            const parsed = new URL(connection.url);
            // Without `//` (postgres:user:pass@host/db) there is no host and
            // the credentials land in the path: never print that.
            if (!parsed.hostname) return 'connection URL without a host';
            return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
        } catch {
            return 'unparseable connection URL';
        }
    }
    return `${connection.host ?? '?'}:${connection.port ?? 5432}/${connection.database ?? '?'}`;
}
