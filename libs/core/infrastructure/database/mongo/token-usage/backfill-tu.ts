/**
 * Backfills the indexable `attributes.tu` sub-doc onto historical
 * `observability_telemetry` spans so the Token Usage screen's covered
 * aggregation (tu_cover_* indexes) can read history — not just spans written
 * after the deploy (the write path already stamps new ones).
 *
 * `tu` is a pure mirror of the dotted-key `gen_ai.usage.*` attributes the old
 * pipeline read, so numbers are identical — it only swaps "scan fat doc" for
 * "read from index". Tier is NOT baked here: it's derived per read from the
 * pricing catalog (see tokenUsage.repository.ts).
 *
 * Prod-safety (this collection can be 100GB+):
 *  - Iterates by `_id` (clustered index) in a resumable, linear sweep — NOT by
 *    the dotted-key token filter (that predicate uses $getField, is unindexable,
 *    and a find() on it re-COLLSCANs a growing prefix each batch → ~O(n²)).
 *  - Idempotent: only stamps docs missing `attributes.tu`, so re-running (or
 *    resuming after a crash / on the next boot) skips finished work.
 *  - Throttled: sleeps between batches to leave replication/WT-cache headroom.
 */
import { Db, ObjectId } from 'mongodb';

const COLLECTION = 'observability_telemetry';

// Kept in sync with SYSTEM_RUN_NAMES in libs/core/log/token-usage-tu.ts — the
// internal analysis run-names excluded from the byok=false ("would-be billable")
// view.
export const BACKFILL_SYSTEM_RUN_NAMES = [
    'selectReviewMode',
    'validateImplementedSuggestions',
    'generateCodeSuggestions',
    'analyzeASTWithAI',
];

// Kept in sync with SUGGESTION_RUN_NAMES in libs/core/log/token-usage-tu.ts
// (asserted equal by token-usage-tu.spec.ts).
export const BACKFILL_SUGGESTION_RUN_NAMES = [
    'severityAnalysis',
    'validateWithLLM',
    'checkSuggestionSimplicity',
    'repeatedCodeReviewSuggestionClustering',
];

const gf = (f: string) => ({ $getField: { field: f, input: '$attributes' } });

// Canonical model = last ':'-segment of gen_ai.response.model (mirrors deriveTu).
const modelExpr = {
    $arrayElemAt: [
        { $split: [{ $ifNull: [gf('gen_ai.response.model'), ''] }, ':'] },
        -1,
    ],
};

// Aggregation mirror of deriveArea() in libs/core/log/token-usage-tu.ts —
// keep the rule order identical (system → kody_rules → cross_file → review →
// suggestions → summary → conversation → other).
const rn = { $ifNull: [gf('gen_ai.run.name'), ''] };
const areaExpr = {
    $switch: {
        branches: [
            { case: { $in: [rn, BACKFILL_SYSTEM_RUN_NAMES] }, then: 'system' },
            {
                case: {
                    $or: [
                        {
                            $regexMatch: {
                                input: rn,
                                regex: 'kody.?rules?',
                                options: 'i',
                            },
                        },
                        {
                            $regexMatch: {
                                input: rn,
                                regex: '^kodyMemory',
                            },
                        },
                    ],
                },
                then: 'kody_rules',
            },
            {
                case: {
                    $regexMatch: { input: rn, regex: '^crossFile' },
                },
                then: 'cross_file',
            },
            {
                case: {
                    $regexMatch: {
                        input: rn,
                        regex: '^(code-review|analyzeCodeWithAI)',
                    },
                },
                then: 'review',
            },
            {
                case: {
                    $or: [
                        { $in: [rn, BACKFILL_SUGGESTION_RUN_NAMES] },
                        {
                            $regexMatch: {
                                input: rn,
                                regex: '^safeguard',
                            },
                        },
                    ],
                },
                then: 'suggestions',
            },
            {
                case: {
                    $regexMatch: { input: rn, regex: '^generateSummaryPR' },
                },
                then: 'summary',
            },
            {
                case: {
                    $or: [
                        { $eq: [rn, 'conversationAgent'] },
                        { $eq: [gf('agent.phase'), 'conversation'] },
                    ],
                },
                then: 'conversation',
            },
        ],
        default: 'other',
    },
};

// Aggregation-pipeline $set that derives `tu` from the flat dotted-key attrs —
// the exact same fields deriveTu reads on the write path. No `tier` (derived at
// read from the catalog).
const SET_TU = {
    $set: {
        'attributes.tu': {
            isByok: { $eq: [gf('type'), 'byok'] },
            sys: { $in: [gf('gen_ai.run.name'), BACKFILL_SYSTEM_RUN_NAMES] },
            model: modelExpr,
            input: { $ifNull: [gf('gen_ai.usage.input_tokens'), 0] },
            output: { $ifNull: [gf('gen_ai.usage.output_tokens'), 0] },
            total: { $ifNull: [gf('gen_ai.usage.total_tokens'), 0] },
            reasoning: { $ifNull: [gf('gen_ai.usage.reasoning_tokens'), 0] },
            cacheRead: {
                $ifNull: [gf('gen_ai.usage.cache_read_input_tokens'), 0],
            },
            cacheWrite: {
                $ifNull: [gf('gen_ai.usage.cache_creation_input_tokens'), 0],
            },
            area: areaExpr,
        },
    },
};

export type BackfillTuOptions = {
    /** Docs per _id batch. Small → bounded oplog + lock time. */
    batch?: number;
    /** Sleep between batches (ms) for replication/cache headroom. */
    sleepMs?: number;
    /** Only stamp docs at/after this timestamp (null = all history). */
    since?: Date | null;
    /** Resume a partial run from this _id (exclusive). */
    resumeFrom?: ObjectId | null;
    /** Scan and count but write nothing. */
    dryRun?: boolean;
    log?: (msg: string) => void;
};

export type BackfillTuResult = {
    scanned: number;
    stamped: number;
    lastId: ObjectId | null;
};

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Only stamp docs that (a) have token usage, (b) lack `tu` OR lack `tu.area`
 * (rows stamped before the area dimension existed), (c) are in window.
 * Re-stamping recomputes the whole `tu` — it's a pure function of the raw
 * attributes, so this stays idempotent.
 */
function stampPredicate(since: Date | null): Record<string, unknown> {
    const p: Record<string, unknown> = {
        $or: [
            { 'attributes.tu': { $exists: false } },
            { 'attributes.tu.area': { $exists: false } },
        ],
        $expr: { $gt: [{ $ifNull: [gf('gen_ai.usage.total_tokens'), 0] }, 0] },
    };
    if (since) p.timestamp = { $gte: since };
    return p;
}

export async function backfillTokenUsageTu(
    db: Db,
    opts: BackfillTuOptions = {},
): Promise<BackfillTuResult> {
    const batch = opts.batch ?? 3000;
    const sleepMs = opts.sleepMs ?? 150;
    const since = opts.since ?? null;
    const dryRun = opts.dryRun ?? false;
    const log = opts.log ?? (() => {});
    const c = db.collection(COLLECTION);
    const predicate = stampPredicate(since);

    log(
        `[token-usage-backfill]${dryRun ? ' [DRY RUN]' : ''} batch=${batch} sleepMs=${sleepMs} since=${
            since ? since.toISOString() : 'none'
        }`,
    );

    // When `since` is set, start the _id sweep at that time (minus a 1s buffer)
    // instead of scanning the whole collection: telemetry is inserted at/after
    // its event `timestamp`, so a doc with `timestamp >= since` always has an
    // `_id >= since` and is never skipped. The updateMany timestamp predicate
    // stays the correctness guarantee; this only bounds the scan.
    const sinceLowerBound = since
        ? ObjectId.createFromTime(Math.floor(since.getTime() / 1000) - 1)
        : null;
    let lastId: ObjectId | null = opts.resumeFrom ?? sinceLowerBound;
    let scanned = 0;
    let stamped = 0;
    const logEvery = batch * 20;
    const t0 = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const ids = (
            await c
                .find(query, { projection: { _id: 1 } })
                .sort({ _id: 1 })
                .limit(batch)
                .toArray()
        ).map((d) => d._id as ObjectId);
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1];
        scanned += ids.length;

        if (!dryRun) {
            const r = await c.updateMany({ _id: { $in: ids }, ...predicate }, [
                SET_TU,
            ]);
            stamped += r.modifiedCount ?? 0;
        }

        if (scanned % logEvery === 0) {
            const rate = Math.round(scanned / ((Date.now() - t0) / 1000 || 1));
            log(
                `[token-usage-backfill] scanned=${scanned} stamped=${stamped} ~${rate}/s lastId=${lastId}`,
            );
        }
        if (sleepMs > 0) await sleep(sleepMs);
    }

    log(
        `[token-usage-backfill] DONE scanned=${scanned} stamped=${stamped} in ${Math.round(
            (Date.now() - t0) / 1000,
        )}s`,
    );
    return { scanned, stamped, lastId };
}
