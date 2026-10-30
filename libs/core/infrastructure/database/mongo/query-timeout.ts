/**
 * Server-side cap for MongoDB reads that back user-facing screens and crons.
 *
 * Without it a slow aggregation keeps running on the cluster after the HTTP
 * client gave up (the API ALB idle timeout is an hour), and every retry stacks
 * another one on top. On 2026-10-06 token-usage aggregations ran for up to 17
 * minutes and the primary piled up to 306 connections. `maxTimeMS` makes mongod
 * abort the operation itself and free the connection, the read ticket and CPU.
 *
 * Override with MONGO_QUERY_MAX_TIME_MS (milliseconds) without a code change.
 */
import { createLogger } from '@libs/core/log/logger';

const DEFAULT_MONGO_QUERY_MAX_TIME_MS = 50_000;
/** Above this an override is a typo, not intent: it would disable the cap. */
const MAX_MONGO_QUERY_MAX_TIME_MS = 10 * 60_000;

type WarnFn = (args: {
    message: string;
    context: string;
    metadata: Record<string, unknown>;
}) => void;

function resolveMaxTimeMs(
    raw: string | undefined,
    warn: WarnFn = (args) => createLogger('MongoQueryTimeout').warn(args),
): number {
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_MONGO_QUERY_MAX_TIME_MS;
    }
    const parsed = Number(raw);
    if (
        Number.isInteger(parsed) &&
        parsed >= 1 &&
        parsed <= MAX_MONGO_QUERY_MAX_TIME_MS
    ) {
        return parsed;
    }
    warn({
        message:
            'Ignoring MONGO_QUERY_MAX_TIME_MS outside [1, max]; using the default',
        context: 'MongoQueryTimeout',
        metadata: {
            configured: raw,
            max: MAX_MONGO_QUERY_MAX_TIME_MS,
            default: DEFAULT_MONGO_QUERY_MAX_TIME_MS,
        },
    });
    return DEFAULT_MONGO_QUERY_MAX_TIME_MS;
}

export const MONGO_QUERY_MAX_TIME_MS = resolveMaxTimeMs(
    process.env.MONGO_QUERY_MAX_TIME_MS,
);

/** mongod error 50 (MaxTimeMSExpired): the query hit `maxTimeMS`. */
export function isMongoQueryTimeout(error: unknown): boolean {
    const e = error as { code?: unknown; codeName?: unknown } | null;
    return e?.code === 50 || e?.codeName === 'MaxTimeMSExpired';
}

export const __test__ = {
    resolveMaxTimeMs,
    DEFAULT_MONGO_QUERY_MAX_TIME_MS,
    MAX_MONGO_QUERY_MAX_TIME_MS,
};
