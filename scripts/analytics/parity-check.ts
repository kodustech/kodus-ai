import 'dotenv/config';

import { MongoClient } from 'mongodb';
import { Client as PgClient } from 'pg';

import { analyticsPostgresConfigLoader } from '@libs/core/infrastructure/config/loaders/analytics-postgres.config.loader';

/**
 * Compares Mongo `pullRequests` against `analytics.pull_requests_opt`
 * per organization to validate backfill / ingestion parity. Prints a
 * per-org table and exits non-zero if any org drifts beyond the
 * configured threshold (default 0.5%).
 *
 * Pure node driver script — no Nest, no Mongoose, no TypeORM. Avoids
 * the schema-plugin / forFeature pitfalls when reusing models in a
 * second module context.
 *
 * Usage:
 *   pnpm run analytics:parity-check
 *   pnpm run analytics:parity-check --org <organizationId>
 *   pnpm run analytics:parity-check --threshold 0.005
 *   pnpm run analytics:parity-check --sample 5
 */

interface CliArgs {
    org?: string;
    threshold: number;
    sample: number;
}

function parseArgs(): CliArgs {
    const out: CliArgs = { threshold: 0.005, sample: 5 };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--org') {
            out.org = next;
            i += 1;
        } else if (arg === '--threshold') {
            out.threshold = Number(next);
            i += 1;
        } else if (arg === '--sample') {
            out.sample = Number(next);
            i += 1;
        }
    }
    return out;
}

function buildMongoUri() {
    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = process.env.API_MG_DB_PORT ?? '27017';
    const user = process.env.API_MG_DB_USERNAME ?? '';
    const pass = process.env.API_MG_DB_PASSWORD ?? '';
    const db = process.env.API_MG_DB_DATABASE ?? 'kodus_db';
    const auth = user && pass ? `${user}:${encodeURIComponent(pass)}@` : '';
    return {
        uri: `mongodb://${auth}${host}:${port}/${db}?authSource=admin`,
        db,
    };
}

interface OrgParity {
    organizationId: string;
    mongoPRs: number;
    pgPRs: number;
    drift: number;
    verdict: 'ok' | 'drift' | 'missing';
}

async function main() {
    const args = parseArgs();

    const mongoCfg = buildMongoUri();
    const mongo = new MongoClient(mongoCfg.uri);
    await mongo.connect();
    const collection = mongo.db(mongoCfg.db).collection('pullRequests');

    const pgCfg = analyticsPostgresConfigLoader();
    const pg = new PgClient({
        host: pgCfg.host,
        port: pgCfg.port,
        user: pgCfg.username,
        password: pgCfg.password,
        database: pgCfg.database,
    });
    await pg.connect();

    let exitCode = 0;
    try {
        const orgs = args.org
            ? [args.org]
            : (
                  (await collection.distinct('organizationId')) as unknown[]
              ).filter((x): x is string => typeof x === 'string');

        if (!orgs.length) {
            // eslint-disable-next-line no-console
            console.warn('no organizations found in Mongo');
            return;
        }

        const rows: OrgParity[] = [];
        for (const org of orgs) {
            const mongoPRs = await collection.countDocuments({
                organizationId: org,
            });
            const pgRes = await pg.query<{ c: string }>(
                `SELECT COUNT(*)::text AS c FROM "${pgCfg.schema}"."pull_requests_opt" WHERE "organizationId" = $1`,
                [org],
            );
            const pgPRs = Number(pgRes.rows[0]?.c ?? 0);

            let drift = 0;
            let verdict: OrgParity['verdict'] = 'ok';
            if (mongoPRs === 0 && pgPRs === 0) {
                verdict = 'ok';
            } else if (pgPRs === 0) {
                verdict = 'missing';
                drift = 1;
            } else {
                drift = Math.abs(mongoPRs - pgPRs) / Math.max(mongoPRs, 1);
                verdict = drift > args.threshold ? 'drift' : 'ok';
            }

            rows.push({
                organizationId: org,
                mongoPRs,
                pgPRs,
                drift,
                verdict,
            });
        }

        rows.sort((a, b) => b.drift - a.drift);
        // eslint-disable-next-line no-console
        console.table(
            rows.map((r) => ({
                organizationId: r.organizationId,
                mongoPRs: r.mongoPRs,
                pgPRs: r.pgPRs,
                drift_pct: (r.drift * 100).toFixed(3),
                verdict: r.verdict,
            })),
        );

        // Spot check: pick `sample` random PRs and compare a few fields.
        if (args.sample > 0) {
            const sampled = (await collection
                .aggregate([
                    { $sample: { size: args.sample } },
                    { $project: { _id: 1, status: 1 } },
                ])
                .toArray()) as Array<{ _id: unknown; status?: string }>;
            const spot: Array<{
                _id: string;
                inPg: boolean;
                mongo_status: string | null;
                pg_status: string | null;
            }> = [];
            for (const d of sampled) {
                const id = String(d._id);
                const r = await pg.query<{ status: string | null }>(
                    `SELECT "status" FROM "${pgCfg.schema}"."pull_requests_opt" WHERE "_id" = $1`,
                    [id],
                );
                spot.push({
                    _id: id,
                    inPg: r.rows.length > 0,
                    mongo_status: d.status ?? null,
                    pg_status: r.rows[0]?.status ?? null,
                });
            }
            // eslint-disable-next-line no-console
            console.log('\nSpot check (random PRs):');
            // eslint-disable-next-line no-console
            console.table(spot);
        }

        const failed = rows.filter((r) => r.verdict !== 'ok');
        if (failed.length) {
            // eslint-disable-next-line no-console
            console.error(
                `\nparity FAILED for ${failed.length}/${rows.length} orgs ` +
                    `(threshold=${(args.threshold * 100).toFixed(2)}%)`,
            );
            exitCode = 1;
        } else {
            // eslint-disable-next-line no-console
            console.log(
                `\nparity OK for ${rows.length} orgs ` +
                    `(threshold=${(args.threshold * 100).toFixed(2)}%)`,
            );
        }
    } finally {
        await mongo.close();
        await pg.end();
    }

    process.exit(exitCode);
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('parity-check crashed:', err);
    process.exit(1);
});
