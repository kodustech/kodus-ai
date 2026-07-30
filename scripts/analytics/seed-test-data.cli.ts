import 'dotenv/config';

import { MongoClient, ObjectId } from 'mongodb';
import { randomInt, randomUUID } from 'crypto';

/**
 * Self-contained seed for analytics ingestion testing.
 *
 * Inserts fake `pullRequests` docs straight into Mongo with the shape
 * the ingestion service consumes. Does NOT touch Postgres OLTP — the
 * ingestion only needs `organizationId` to be a non-null string, no FK
 * relationship is enforced on the warehouse side.
 *
 * Usage:
 *   pnpm run analytics:seed-test                 # 3 orgs × 50 PRs over 90 days
 *   pnpm run analytics:seed-test --orgs 5 --prs 200 --days 365
 *   pnpm run analytics:seed-test --with-edge-cases
 *   pnpm run analytics:seed-test --reset         # wipe seeded docs (by org tag)
 *   pnpm run analytics:seed-test --org-prefix qa # custom tag, default 'analytics-test'
 *
 * Tagging: every seeded doc carries `organizationId = "<prefix>-<n>"` so
 * `--reset` can find and delete them without touching real data.
 */

interface CliArgs {
    orgs: number;
    prsPerOrg: number;
    days: number;
    orgPrefix: string;
    withEdgeCases: boolean;
    reset: boolean;
    mongoUri?: string;
    mongoDb?: string;
}

function parseArgs(): CliArgs {
    const out: CliArgs = {
        orgs: 3,
        prsPerOrg: 50,
        days: 90,
        orgPrefix: 'analytics-test',
        withEdgeCases: false,
        reset: false,
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--orgs':
                out.orgs = Number(next);
                i += 1;
                break;
            case '--prs':
                out.prsPerOrg = Number(next);
                i += 1;
                break;
            case '--days':
                out.days = Number(next);
                i += 1;
                break;
            case '--org-prefix':
                out.orgPrefix = next;
                i += 1;
                break;
            case '--with-edge-cases':
                out.withEdgeCases = true;
                break;
            case '--reset':
                out.reset = true;
                break;
            case '--mongo-uri':
                out.mongoUri = next;
                i += 1;
                break;
            case '--mongo-db':
                out.mongoDb = next;
                i += 1;
                break;
            default:
                if (arg?.startsWith('--')) {
                    throw new Error(`unknown flag: ${arg}`);
                }
        }
    }
    return out;
}

function buildMongoUri(args: CliArgs): {
    uri: string;
    db: string;
} {
    if (args.mongoUri) {
        return { uri: args.mongoUri, db: args.mongoDb ?? 'kodus_db' };
    }
    // Honors API_MG_DB_* exactly as set. Run inside the analytics
    // worker container (`docker exec -it as_kodus_analytics_worker pnpm
    // analytics:seed-test ...`) so DNS resolves the in-network host.
    // From the host machine, override with --mongo-uri pointing at the
    // mapped port, e.g.
    //   --mongo-uri "mongodb://kodusdev:123456@localhost:27117/kodus_db?authSource=admin"
    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = process.env.API_MG_DB_PORT ?? '27017';
    const user = process.env.API_MG_DB_USERNAME ?? '';
    const pass = process.env.API_MG_DB_PASSWORD ?? '';
    const db = args.mongoDb ?? process.env.API_MG_DB_DATABASE ?? 'kodus_db';
    const auth = user && pass ? `${user}:${encodeURIComponent(pass)}@` : '';
    return {
        uri: `mongodb://${auth}${host}:${port}/${db}?authSource=admin`,
        db,
    };
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const LABELS = [
    'security',
    'performance',
    'maintainability',
    'documentation',
    'bug',
    'refactoring',
];
const STATUSES = ['open', 'closed', 'merged'];
const DELIVERY = ['sent', 'pending', 'failed'];
const IMPL = ['implemented', 'partially_implemented', 'not_implemented'];

// Uses `crypto.randomInt` instead of `Math.random` not because this
// is security-sensitive (it's test-data generation) but because CodeQL
// flags any `Math.random()` dataflow into identifiers — and an
// analytics seed script isn't worth the audit noise.
function pick<T>(arr: readonly T[]): T {
    return arr[randomInt(arr.length)];
}

function rand(min: number, max: number): number {
    return randomInt(min, max + 1);
}

function randFloat(): number {
    // One float in [0, 1). Preserves the old Math.random() semantic
    // for callers that want a unit rank/score.
    return randomInt(0, 1_000_000) / 1_000_000;
}

function makeFiles(n: number, prCreatedAt: Date) {
    const files = [];
    for (let i = 0; i < n; i += 1) {
        const sCount = rand(0, 4);
        const suggestions = [];
        for (let s = 0; s < sCount; s += 1) {
            suggestions.push({
                id: randomUUID(),
                relevantFile: `src/file_${i}.ts`,
                language: 'typescript',
                suggestionContent: `Suggestion ${s} for file ${i}`,
                existingCode: '// before',
                improvedCode: '// after',
                oneSentenceSummary: `Fix issue ${s}`,
                relevantLinesStart: rand(1, 200),
                relevantLinesEnd: rand(200, 400),
                label: pick(LABELS),
                severity: pick(SEVERITIES),
                rankScore: randFloat(),
                priorityStatus: 'prioritized',
                deliveryStatus: pick(DELIVERY),
                implementationStatus: pick(IMPL),
                comment: { id: rand(1, 100000), pullRequestReviewId: rand(1, 100000) },
                createdAt: prCreatedAt.toISOString(),
                updatedAt: prCreatedAt.toISOString(),
            });
        }
        files.push({
            id: randomUUID(),
            sha: randomUUID().replace(/-/g, ''),
            path: `src/file_${i}.ts`,
            filename: `file_${i}.ts`,
            previousName: '',
            status: 'modified',
            createdAt: prCreatedAt.toISOString(),
            updatedAt: prCreatedAt.toISOString(),
            added: rand(1, 50),
            deleted: rand(0, 30),
            changes: rand(1, 80),
            reviewMode: 'full',
            codeReviewModelUsed: {
                generateSuggestions: 'gemini-2.0',
                safeguard: 'gemini-2.0',
            },
            suggestions,
        });
    }
    return files;
}

function makeCommits(n: number, prCreatedAt: Date, prClosedAt: Date | null) {
    const commits = [];
    const start = prCreatedAt.getTime();
    const end = (prClosedAt ?? new Date()).getTime();
    for (let i = 0; i < n; i += 1) {
        const ts = new Date(start + ((end - start) * (i + 1)) / (n + 1));
        commits.push({
            sha: randomUUID().replace(/-/g, '').slice(0, 40),
            commit_timestamp: ts.toISOString(),
            createdAt: ts.toISOString(),
            author: {
                username: `dev_${rand(1, 5)}`,
                name: `Dev ${rand(1, 5)}`,
            },
        });
    }
    return commits;
}

function makePR(input: {
    organizationId: string;
    number: number;
    createdAt: Date;
    updatedAt?: Date;
    status?: string;
    closed?: boolean;
}) {
    const status = input.status ?? pick(STATUSES);
    const closed = input.closed ?? status !== 'open';
    const closedAt = closed
        ? new Date(
              input.createdAt.getTime() +
                  rand(1, 14) * 86_400_000,
          )
        : null;
    const updatedAt = input.updatedAt ?? closedAt ?? input.createdAt;
    const fileCount = rand(1, 6);
    const commitCount = rand(1, 5);
    const files = makeFiles(fileCount, input.createdAt);
    const totalAdded = files.reduce((s, f) => s + f.added, 0);
    const totalDeleted = files.reduce((s, f) => s + f.deleted, 0);

    return {
        _id: new ObjectId(),
        title: `Test PR #${input.number}`,
        status,
        number: input.number,
        merged: status === 'merged',
        url: `https://github.com/test/${input.organizationId}/pull/${input.number}`,
        baseBranchRef: 'main',
        headBranchRef: `feature/${input.number}`,
        openedAt: input.createdAt.toISOString(),
        closedAt: closedAt?.toISOString() ?? null,
        repository: {
            id: `repo-${input.organizationId}`,
            name: `repo-${input.organizationId}`,
            fullName: `test-org/repo-${input.organizationId}`,
            language: 'typescript',
            url: `https://github.com/test-org/repo-${input.organizationId}`,
            createdAt: input.createdAt.toISOString(),
            updatedAt: updatedAt.toISOString(),
        },
        files,
        totalAdded,
        totalDeleted,
        totalChanges: totalAdded + totalDeleted,
        provider: 'github',
        user: {
            id: `user-${rand(1, 10)}`,
            username: `dev_${rand(1, 5)}`,
        },
        reviewers: [],
        assignees: [],
        organizationId: input.organizationId,
        commits: makeCommits(commitCount, input.createdAt, closedAt),
        syncedEmbeddedSuggestions: false,
        syncedWithIssues: false,
        prLevelSuggestions: [],
        isDraft: false,
        createdAt: input.createdAt,
        updatedAt,
    };
}

async function main() {
    const args = parseArgs();
    const { uri, db } = buildMongoUri(args);

    const client = new MongoClient(uri);
    await client.connect();
    const collection = client.db(db).collection('pullRequests');

    const orgIds = Array.from(
        { length: args.orgs },
        (_, i) => `${args.orgPrefix}-${String(i + 1).padStart(3, '0')}`,
    );

    if (args.reset) {
        const res = await collection.deleteMany({
            organizationId: { $in: orgIds },
        });
        // eslint-disable-next-line no-console
        console.log(
            `[reset] deleted ${res.deletedCount} docs for orgs: ${orgIds.join(', ')}`,
        );
        await client.close();
        return;
    }

    const now = Date.now();
    const span = args.days * 86_400_000;

    let totalInserted = 0;
    for (const org of orgIds) {
        const docs = [];
        for (let i = 0; i < args.prsPerOrg; i += 1) {
            const createdAt = new Date(now - randFloat() * span);
            docs.push(
                makePR({
                    organizationId: org,
                    number: i + 1,
                    createdAt,
                }),
            );
        }
        if (docs.length) {
            await collection.insertMany(docs);
            totalInserted += docs.length;
            // eslint-disable-next-line no-console
            console.log(`[seed] org=${org} inserted=${docs.length}`);
        }
    }

    if (args.withEdgeCases) {
        const edgeOrg = `${args.orgPrefix}-edge`;
        // Edge case 1: two PRs with the IDENTICAL updatedAt — exercises
        // the tuple watermark. Without it, the second would be skipped
        // forever after the first run advances past their shared timestamp.
        const sharedTs = new Date(now - 2 * 86_400_000);
        const twin1 = makePR({
            organizationId: edgeOrg,
            number: 9001,
            createdAt: new Date(sharedTs.getTime() - 86_400_000),
            updatedAt: sharedTs,
        });
        const twin2 = makePR({
            organizationId: edgeOrg,
            number: 9002,
            createdAt: new Date(sharedTs.getTime() - 86_400_000),
            updatedAt: sharedTs,
        });
        // Edge case 2: malformed `files` (string instead of array) —
        // exercises the per-PR SAVEPOINT quarantine path.
        const malformed = makePR({
            organizationId: edgeOrg,
            number: 9003,
            createdAt: new Date(now - 86_400_000),
        });
        (malformed as unknown as { files: unknown }).files = 'not-an-array';
        // Edge case 3: PR with empty children — sanity that no children
        // fanout doesn't crash.
        const empty = makePR({
            organizationId: edgeOrg,
            number: 9004,
            createdAt: new Date(now - 3 * 86_400_000),
        });
        empty.files = [];
        empty.commits = [];

        await collection.insertMany([twin1, twin2, malformed, empty]);
        totalInserted += 4;
        // eslint-disable-next-line no-console
        console.log(
            `[seed] edge cases inserted into org=${edgeOrg}: ` +
                `tuple-twins(${twin1.number},${twin2.number}) ` +
                `malformed(${malformed.number}) empty(${empty.number})`,
        );
    }

    // eslint-disable-next-line no-console
    console.log(
        `\n[seed] total inserted=${totalInserted} across ${orgIds.length} orgs ` +
            `${args.withEdgeCases ? '(+ edge cases)' : ''}`,
    );
    // eslint-disable-next-line no-console
    console.log('\nNext steps:');
    // eslint-disable-next-line no-console
    console.log(
        '  1. Wait for the analytics cron tick (or set ANALYTICS_INGESTION_CRON=*/1 * * * *)',
    );
    // eslint-disable-next-line no-console
    console.log('  2. curl http://localhost:3001/cockpit/health/runs');
    // eslint-disable-next-line no-console
    console.log(
        `  3. pnpm run analytics:parity-check --org ${orgIds[0]}`,
    );

    await client.close();
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('seed crashed:', err);
    process.exit(1);
});
