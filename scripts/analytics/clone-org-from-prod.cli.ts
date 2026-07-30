import { existsSync, readFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';

import {
    AnyBulkWriteOperation,
    Document,
    MongoClient,
    WithId,
} from 'mongodb';

/**
 * Clone the `pullRequests` docs of ONE organization from a source Mongo
 * (typically PROD, read-only) into a destination Mongo (dev), rewriting
 * `organizationId` to a target org id along the way.
 *
 * Why this exists: `seed-test-data` generates synthetic PRs but cannot
 * exercise the shape variety that real data has; `parity-vs-bq` only
 * tests the HTTP layer. To properly smoke-test the ingestion
 * (watermark `(updatedAt, _id)` resume, SAVEPOINT quarantine, chunked
 * backfill) we need real docs in dev Mongo with their original
 * `_id` / `createdAt` / `updatedAt` preserved.
 *
 * Env files:
 *   `.env.prod` — the SOURCE (PROD). Reads `API_MG_DB_*` + auth source.
 *                 Never written to `process.env`; parsed in isolation so
 *                 it cannot collide with the dev `API_MG_DB_*` values.
 *   `.env`      — the DESTINATION (dev). Same shape. Also parsed in
 *                 isolation (falls back to `process.env` only when the
 *                 file doesn't exist, to keep backwards compat with
 *                 users running inside a container that injects envs).
 *
 * Usage:
 *   pnpm run analytics:clone-from-prod \
 *     --source-org 11111111-1111-1111-1111-111111111111 \
 *     --target-org analytics-test-kodus
 *
 *   # two-phase watermark test (dump up to T, then delta from T onward)
 *   pnpm run analytics:clone-from-prod --source-org <src> --target-org <dst> \
 *     --until 2026-04-20T00:00:00Z --reset-target
 *   pnpm run analytics:clone-from-prod --source-org <src> --target-org <dst> \
 *     --since 2026-04-20T00:00:00Z
 *
 * Safety rails:
 *   - aborts if `.env.prod` is missing or empty.
 *   - aborts if source host == destination host.
 *   - aborts if `--source-org == --target-org`.
 */

/**
 * Collections the cockpit pipeline reads from Mongo:
 *  - pullRequests        → suggestions_mv / pull_requests_opt (ingestion)
 *  - codeReviewFeedback  → suggestion_feedback (thumbs up/down)
 *  - kodyRules           → rule titles/states for the rules-health table
 *
 * `kodyRules` is one doc per org. CAUTION: cloning it adds a SECOND doc
 * for the target org unless `--reset-target` removes the existing one —
 * which also wipes any locally created rules for that org.
 */
const CLONABLE_COLLECTIONS = [
    'pullRequests',
    'codeReviewFeedback',
    'kodyRules',
] as const;
type ClonableCollection = (typeof CLONABLE_COLLECTIONS)[number];

/** Collections whose docs carry usable `updatedAt` for window filters. */
const WINDOWED_COLLECTIONS: ReadonlySet<string> = new Set([
    'pullRequests',
    'codeReviewFeedback',
]);

const DEFAULT_DB = 'kodus_db';
const DEFAULT_BATCH = 200;
const PROD_ENV_PATH = '.env.prod';
const DEV_ENV_PATH = '.env';

interface CliArgs {
    sourceOrg: string;
    targetOrg: string;
    since?: Date;
    until?: Date;
    batch: number;
    dryRun: boolean;
    resetTarget: boolean;
    collections: ClonableCollection[];
    sourceMongoUri?: string;
    destMongoUri?: string;
    destMongoHost?: string;
}

function parseArgs(): CliArgs {
    const out: Partial<CliArgs> = {
        batch: DEFAULT_BATCH,
        dryRun: false,
        resetTarget: false,
        collections: [...CLONABLE_COLLECTIONS],
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--source-org':
                out.sourceOrg = next;
                i += 1;
                break;
            case '--target-org':
                out.targetOrg = next;
                i += 1;
                break;
            case '--since':
                out.since = parseDateArg('--since', next);
                i += 1;
                break;
            case '--until':
                out.until = parseDateArg('--until', next);
                i += 1;
                break;
            case '--batch':
                out.batch = Number(next);
                if (!Number.isFinite(out.batch) || out.batch <= 0) {
                    throw new Error(`--batch must be a positive number`);
                }
                i += 1;
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            case '--reset-target':
                out.resetTarget = true;
                break;
            case '--collections': {
                const list = (next ?? '')
                    .split(',')
                    .map((c) => c.trim())
                    .filter(Boolean);
                for (const c of list) {
                    if (
                        !CLONABLE_COLLECTIONS.includes(
                            c as ClonableCollection,
                        )
                    ) {
                        throw new Error(
                            `--collections got "${c}"; valid: ${CLONABLE_COLLECTIONS.join(', ')}`,
                        );
                    }
                }
                out.collections = list as ClonableCollection[];
                i += 1;
                break;
            }
            case '--source-mongo-uri':
                out.sourceMongoUri = next;
                i += 1;
                break;
            case '--dest-mongo-uri':
                out.destMongoUri = next;
                i += 1;
                break;
            case '--dest-mongo-host':
                out.destMongoHost = next;
                i += 1;
                break;
            default:
                if (arg?.startsWith('--')) {
                    throw new Error(`unknown flag: ${arg}`);
                }
        }
    }
    if (!out.sourceOrg) throw new Error('--source-org is required');
    if (!out.targetOrg) throw new Error('--target-org is required');
    return out as CliArgs;
}

function parseDateArg(flag: string, raw: string | undefined): Date {
    if (!raw) throw new Error(`${flag} requires an ISO timestamp`);
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
        throw new Error(`${flag} got an invalid date: "${raw}"`);
    }
    return d;
}

/**
 * Read `.env.<x>` into a plain object WITHOUT touching `process.env`.
 * This is the safety feature that lets us read prod and dev configs
 * with overlapping variable names (`API_MG_DB_*`) side by side without
 * either one leaking into the global env.
 */
function readEnvFile(path: string): Record<string, string> | null {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return parseDotenv(raw);
}

interface MongoEnv {
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    authSource?: string;
}

function readMongoEnv(bag: Record<string, string>): MongoEnv {
    return {
        host: bag.API_MG_DB_HOST?.trim() || undefined,
        port: bag.API_MG_DB_PORT?.trim() || undefined,
        username: bag.API_MG_DB_USERNAME?.trim() || undefined,
        password: bag.API_MG_DB_PASSWORD?.trim() || undefined,
        database: bag.API_MG_DB_DATABASE?.trim() || undefined,
        authSource: bag.API_MG_DB_AUTH_SOURCE?.trim() || undefined,
    };
}

function buildMongoUri(env: MongoEnv, label: string): { uri: string; db: string } {
    if (!env.host) {
        throw new Error(`${label}: API_MG_DB_HOST is missing`);
    }
    const db = env.database ?? DEFAULT_DB;
    const authSource = env.authSource ?? 'admin';
    const auth =
        env.username && env.password
            ? `${encodeURIComponent(env.username)}:${encodeURIComponent(env.password)}@`
            : '';

    // No port → assume managed cluster (DigitalOcean, Atlas) → SRV + TLS.
    // With port → assume plain Mongo (dev docker, self-hosted).
    if (!env.port) {
        return {
            uri: `mongodb+srv://${auth}${env.host}/${db}?authSource=${authSource}&tls=true`,
            db,
        };
    }
    return {
        uri: `mongodb://${auth}${env.host}:${env.port}/${db}?authSource=${authSource}`,
        db,
    };
}

function hostOf(uri: string): string {
    const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
    const afterAuth = afterScheme.includes('@')
        ? afterScheme.slice(afterScheme.indexOf('@') + 1)
        : afterScheme;
    const hostPart = afterAuth.split('/')[0] ?? '';
    return hostPart
        .split(',')
        .map((h) => h.split(':')[0])
        .sort()
        .join(',')
        .toLowerCase();
}

function redactUri(uri: string): string {
    return uri.replace(/(mongodb(\+srv)?:\/\/)[^@]+@/, '$1***:***@');
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}m${rem.toFixed(0).padStart(2, '0')}s`;
}

function buildFilter(args: CliArgs, collection?: string): Document {
    const filter: Document = { organizationId: args.sourceOrg };
    const windowed = !collection || WINDOWED_COLLECTIONS.has(collection);
    if (windowed && (args.since || args.until)) {
        const range: Document = {};
        if (args.since) range.$gte = args.since;
        if (args.until) range.$lte = args.until;
        filter.updatedAt = range;
    }
    return filter;
}

function resolveSource(args: CliArgs): { uri: string; db: string } {
    if (args.sourceMongoUri) {
        return { uri: args.sourceMongoUri, db: DEFAULT_DB };
    }
    const prodBag = readEnvFile(PROD_ENV_PATH);
    if (!prodBag) {
        throw new Error(
            `${PROD_ENV_PATH} not found — create it with the PROD API_MG_DB_* values ` +
                `(read-only user preferred). This file stays local (gitignored).`,
        );
    }
    return buildMongoUri(readMongoEnv(prodBag), PROD_ENV_PATH);
}

function resolveDest(args: CliArgs): { uri: string; db: string } {
    if (args.destMongoUri) {
        return { uri: args.destMongoUri, db: DEFAULT_DB };
    }
    const devBag =
        readEnvFile(DEV_ENV_PATH) ??
        (process.env.API_MG_DB_HOST ? (process.env as Record<string, string>) : null);
    if (!devBag) {
        throw new Error(
            `${DEV_ENV_PATH} not found and API_MG_DB_HOST not in process.env — ` +
                `cannot resolve the destination Mongo.`,
        );
    }
    const env = readMongoEnv(devBag);
    // Running from the host while `.env` uses a docker-compose service
    // name (e.g. `db_mongodb`) won't resolve — let the caller override
    // just the host, keeping creds/port/db from `.env`.
    if (args.destMongoHost) {
        env.host = args.destMongoHost;
    }
    return buildMongoUri(env, DEV_ENV_PATH);
}

async function main() {
    const args = parseArgs();

    const source = resolveSource(args);
    const dest = resolveDest(args);

    if (hostOf(source.uri) === hostOf(dest.uri)) {
        throw new Error(
            `Source and destination Mongo hosts are identical ` +
                `(${hostOf(source.uri)}). Refusing to run.`,
        );
    }
    if (args.sourceOrg === args.targetOrg) {
        throw new Error(
            `--source-org equals --target-org (${args.sourceOrg}).`,
        );
    }

    console.log('clone-org-from-prod starting');
    console.log(`  source      : ${redactUri(source.uri)}`);
    console.log(`  dest        : ${redactUri(dest.uri)}`);
    console.log(`  source org  : ${args.sourceOrg}`);
    console.log(`  target org  : ${args.targetOrg}`);
    if (args.since) console.log(`  since       : ${args.since.toISOString()}`);
    if (args.until) console.log(`  until       : ${args.until.toISOString()}`);
    console.log(`  batch size  : ${args.batch}`);
    console.log(`  dry-run     : ${args.dryRun}`);
    console.log(`  reset-target: ${args.resetTarget}`);
    console.log(`  collections : ${args.collections.join(', ')}`);

    const sourceClient = new MongoClient(source.uri);
    const destClient = new MongoClient(dest.uri);

    const startedAt = Date.now();
    let totalScanned = 0;
    let totalUpserted = 0;

    try {
        await Promise.all([sourceClient.connect(), destClient.connect()]);

        for (const collection of args.collections) {
            const stats = await cloneCollection({
                sourceClient,
                destClient,
                source,
                dest,
                args,
                collection,
            });
            totalScanned += stats.scanned;
            totalUpserted += stats.upserted;
        }
    } finally {
        await Promise.allSettled([sourceClient.close(), destClient.close()]);
    }

    const elapsed = Date.now() - startedAt;
    console.log('\nall done.');
    console.log(`  total scanned : ${totalScanned}`);
    console.log(`  total upserted: ${totalUpserted}`);
    console.log(`  elapsed       : ${formatDuration(elapsed)}`);
}

async function cloneCollection({
    sourceClient,
    destClient,
    source,
    dest,
    args,
    collection,
}: {
    sourceClient: MongoClient;
    destClient: MongoClient;
    source: { uri: string; db: string };
    dest: { uri: string; db: string };
    args: CliArgs;
    collection: ClonableCollection;
}): Promise<{ scanned: number; upserted: number }> {
    const sourceColl = sourceClient
        .db(source.db)
        .collection<Document>(collection);
    const destColl = destClient.db(dest.db).collection<Document>(collection);

    let scanned = 0;
    let upserted = 0;
    let newestUpdatedAt: Date | null = null;

    const filter = buildFilter(args, collection);
    const totalToScan = await sourceColl.countDocuments(filter);
    console.log(`\n[${collection}] ${totalToScan} source docs match`);

    if (args.dryRun) {
        console.log(`[${collection}] dry-run: not writing.`);
        return { scanned: 0, upserted: 0 };
    }
    if (totalToScan === 0) {
        return { scanned: 0, upserted: 0 };
    }

    if (args.resetTarget) {
        const res = await destColl.deleteMany({
            organizationId: args.targetOrg,
        });
        console.log(
            `[${collection}] reset-target: deleted ${res.deletedCount ?? 0} existing docs for org ${args.targetOrg}`,
        );
    }

    const windowed = WINDOWED_COLLECTIONS.has(collection);
    const cursor = sourceColl
        .find(filter)
        .sort(windowed ? { updatedAt: 1, _id: 1 } : { _id: 1 })
        .batchSize(args.batch)
        .addCursorFlag('noCursorTimeout', true);

    const buffer: AnyBulkWriteOperation<Document>[] = [];
    let lastLoggedAt = Date.now();

    const flush = async () => {
        if (!buffer.length) return;
        const res = await destColl.bulkWrite(buffer, { ordered: false });
        upserted += (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
        buffer.length = 0;
    };

    for await (const raw of cursor) {
        const doc = raw as WithId<Document>;
        scanned += 1;

        const u = doc.updatedAt;
        if (u instanceof Date) {
            if (!newestUpdatedAt || u > newestUpdatedAt) {
                newestUpdatedAt = u;
            }
        }

        const rewritten: Document = {
            ...doc,
            organizationId: args.targetOrg,
        };
        buffer.push({
            replaceOne: {
                filter: { _id: doc._id },
                replacement: rewritten,
                upsert: true,
            },
        });

        if (buffer.length >= args.batch) {
            await flush();
        }

        if (Date.now() - lastLoggedAt > 2000) {
            const pct = ((scanned / totalToScan) * 100).toFixed(1);
            console.log(
                `[${collection}]   … ${scanned}/${totalToScan} (${pct}%) scanned, ${upserted} written`,
            );
            lastLoggedAt = Date.now();
        }
    }

    await flush();

    console.log(
        `[${collection}] done: scanned=${scanned} upserted=${upserted} ` +
            `newest updatedAt=${newestUpdatedAt ? newestUpdatedAt.toISOString() : 'n/a'}`,
    );
    return { scanned, upserted };
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
