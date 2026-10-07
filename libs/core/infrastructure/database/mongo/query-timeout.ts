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
const DEFAULT_MONGO_QUERY_MAX_TIME_MS = 50_000;

function resolveMaxTimeMs(raw: string | undefined): number {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0
        ? parsed
        : DEFAULT_MONGO_QUERY_MAX_TIME_MS;
}

export const MONGO_QUERY_MAX_TIME_MS = resolveMaxTimeMs(
    process.env.MONGO_QUERY_MAX_TIME_MS,
);

/** mongod error 50 (MaxTimeMSExpired): the query hit `maxTimeMS`. */
export function isMongoQueryTimeout(error: unknown): boolean {
    const e = error as { code?: unknown; codeName?: unknown } | null;
    return e?.code === 50 || e?.codeName === 'MaxTimeMSExpired';
}

export const __test__ = { resolveMaxTimeMs, DEFAULT_MONGO_QUERY_MAX_TIME_MS };
