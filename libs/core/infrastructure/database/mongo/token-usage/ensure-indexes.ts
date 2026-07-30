/**
 * Token Usage covering indexes on `observability_telemetry`.
 *
 * The screen aggregates token usage per org + timestamp window. Reading the
 * pre-derived `attributes.tu.*` sub-doc through these covering indexes keeps the
 * aggregation index-only (docsExamined=0) instead of FETCHing ~millions of fat
 * spans. One partial index per view flag (isByok / sys) so the planner can bound
 * its flag and stay covered. Keys proven covered via explain for every screen
 * query shape (summary/byModel/daily/byPr/overview-$facet).
 *
 * Idempotent: createIndex is a no-op when the same name+spec already exists;
 * the dead-index drops are best-effort. Safe to run on every boot.
 */
import { Db } from 'mongodb';

const COLLECTION = 'observability_telemetry';

// Summed usage fields — carried in the index so the $group reads them without a
// FETCH. `attributes.tu.input` also feeds the read-time tier derivation.
const SUM_KEYS = {
    'attributes.tu.input': 1,
    'attributes.tu.output': 1,
    'attributes.tu.total': 1,
    'attributes.tu.reasoning': 1,
    'attributes.tu.cacheRead': 1,
    'attributes.tu.cacheWrite': 1,
} as const;

// Superseded indexes. The two `createdAt` compounds were never used by the
// planner — every read filters on `timestamp` (the exporter's event time), not
// the Mongoose `timestamps: true` `createdAt` — yet cost disk + write latency.
// `tu_cover` is a legacy dev-only top-level index.
const DEAD_INDEXES = [
    'attributes.organizationId_1_createdAt_-1',
    'attributes.organizationId_1_attributes.prNumber_1_createdAt_-1',
    'tu_cover',
    // v1 covers, superseded by *_v2 (which add tu.area + correlationId so the
    // by-area and by-review aggregations stay covered).
    'tu_cover_byok',
    'tu_cover_sys',
];

type Logger = (msg: string) => void;

export async function ensureTokenUsageIndexes(
    db: Db,
    log: Logger = () => {},
): Promise<void> {
    const c = db.collection(COLLECTION);

    log('[token-usage-indexes] building tu_cover_byok_v2…');
    await c.createIndex(
        {
            'attributes.organizationId': 1,
            'attributes.tu.isByok': 1,
            timestamp: 1,
            'attributes.tu.model': 1,
            'attributes.prNumber': 1,
            'attributes.tu.area': 1,
            correlationId: 1,
            ...SUM_KEYS,
        },
        {
            name: 'tu_cover_byok_v2',
            partialFilterExpression: { 'attributes.tu.isByok': true },
        },
    );

    log('[token-usage-indexes] building tu_cover_sys_v2…');
    await c.createIndex(
        {
            'attributes.organizationId': 1,
            'attributes.tu.sys': 1,
            timestamp: 1,
            'attributes.tu.model': 1,
            'attributes.prNumber': 1,
            'attributes.tu.area': 1,
            correlationId: 1,
            ...SUM_KEYS,
        },
        {
            name: 'tu_cover_sys_v2',
            partialFilterExpression: { 'attributes.tu.sys': { $exists: true } },
        },
    );

    for (const name of DEAD_INDEXES) {
        try {
            await c.dropIndex(name);
            log(`[token-usage-indexes] dropped dead index ${name}`);
        } catch {
            /* not present — fine */
        }
    }
    log('[token-usage-indexes] done');
}

export async function dropTokenUsageIndexes(
    db: Db,
    log: Logger = () => {},
): Promise<void> {
    const c = db.collection(COLLECTION);
    for (const name of ['tu_cover_byok_v2', 'tu_cover_sys_v2']) {
        try {
            await c.dropIndex(name);
            log(`[token-usage-indexes] dropped ${name}`);
        } catch {
            /* not present */
        }
    }
}
