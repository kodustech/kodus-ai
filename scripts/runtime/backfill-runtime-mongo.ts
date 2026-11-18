// One-off: copies what the Runtime kept in Mongo into the Postgres tables that
// replaced it, so the dev screens keep their history.
//
//   Runtime Postgres (RUNTIME_DATABASE_URL, the Runtime owner):
//     runtime_runs, runtime_environment_setups, runtime_lessons
//     → runtime.runtime_runs, runtime.runtime_environment_setups, runtime.runtime_lessons
//     The script applies the Runtime migrations first (runtime-schema.ts, v21
//     included; idempotent, under the same advisory lock as the worker), so it
//     can run before the new runtime-worker starts.
//   Product Postgres (RUNTIME_BACKFILL_PRODUCT_DATABASE_URL, optional):
//     runtime_publications, runtime_pr_comments → the tables of the product
//     migration MoveRuntimeProductStoresToPostgres2026111200000000, which must
//     have run (the API applies it at boot). Without them an older PR gets a
//     second Runtime comment instead of its first one edited, and the Run page
//     of an older Run shows no publication.
//   Receipts, call counts, budgets and the env audit are not copied.
//
// Idempotent, and safe after the new services already write Postgres:
//   - a Run already in Postgres keeps every field Postgres has; the Mongo
//     document only fills what Postgres lacks;
//   - a setup or a lesson is replaced only by a newer Mongo document
//     (updated_at / last_at);
//   - a publication or a comment slot already in Postgres is kept as it is.
// A document that cannot be copied (a missing required field, a time that
// does not parse) is reported by id and skipped; the exit code is 1 then.
//
// Usage:
//   RUNTIME_BACKFILL_MONGO_URL=mongodb://… RUNTIME_BACKFILL_MONGO_DB=kodus \
//   RUNTIME_DATABASE_URL=postgres://kodus_runtime:…@…/kodus_runtime \
//   [RUNTIME_BACKFILL_PRODUCT_DATABASE_URL=postgres://…/kodus_db] \
//   TS_NODE_PROJECT=apps/runtime/tsconfig.json \
//   node -r ts-node/register/transpile-only -r tsconfig-paths/register scripts/runtime/backfill-runtime-mongo.ts [--dry-run]

import { MongoClient } from 'mongodb';
import { Pool } from 'pg';

import { LESSON_COLUMNS, RUNTIME_LESSONS_TABLE } from '@libs/runtime/blockers/pg-lesson.store';
import { type DocumentTable, jsonb } from '@libs/runtime/run/adapters/pg-document';
import { RUNTIME_ENVIRONMENT_SETUPS_TABLE, SETUP_COLUMNS } from '@libs/runtime/run/adapters/pg-environment-setup.store';
import { RUN_COLUMNS, RUNTIME_RUNS_TABLE } from '@libs/runtime/run/adapters/pg-run-projection.store';
import { RUNTIME_PR_COMMENTS_TABLE, SLOT_COLUMNS } from '@libs/runtime-publish/infrastructure/typeorm-comment-slot.store';
import { PUBLICATION_COLUMNS, RUNTIME_PUBLICATIONS_TABLE } from '@libs/runtime-publish/infrastructure/typeorm-publication.store';

import { ensureRuntimeSchema } from '../../apps/runtime/src/shared/persistence/runtime-schema';

/** A column of the INSERT and its value; jsonb values are cast. */
type Row = Array<{ column: string; value: unknown; json?: boolean }>;

interface Target {
    collection: string;
    database: 'runtime' | 'product';
    table: string;
    key: string;
    row: (doc: Record<string, unknown>) => Row;
    /** The ON CONFLICT action, given the columns written. */
    onConflict: (columns: string[]) => string;
}

/** The document's typed columns, then its rest as the jsonb column (or `restAs` columns of their own). */
function rowOf(table: DocumentTable<object>, doc: Record<string, unknown>, own: Record<string, { value: unknown; json?: boolean }> = {}): Row {
    const split = table.split(doc);
    const row: Row = split.columns.map((column, i) => ({ column, value: split.values[i] }));
    if (!Object.keys(own).length) return [...row, { column: table.rest, value: jsonb(split.rest), json: true }];
    return [...row, ...Object.entries(own).map(([column, v]) => ({ column, ...v }))];
}

const replaceIfNewer = (key: string, time: string) => (cols: string[]) =>
    `DO UPDATE SET ${cols.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`).join(', ')} WHERE t.${time} < EXCLUDED.${time}`;

const TARGETS: Target[] = [
    {
        collection: 'runtime_runs',
        database: 'runtime',
        table: RUNTIME_RUNS_TABLE,
        key: 'run_id',
        row: (doc) => rowOf(RUN_COLUMNS as DocumentTable<object>, doc),
        // What Postgres has wins, field by field; Mongo fills the gaps.
        onConflict: (cols) =>
            `DO UPDATE SET ${cols
                .filter((c) => c !== 'run_id' && c !== 'report')
                .map((c) => `${c} = COALESCE(t.${c}, EXCLUDED.${c})`)
                .concat('report = EXCLUDED.report || t.report')
                .join(', ')}`,
    },
    {
        collection: 'runtime_environment_setups',
        database: 'runtime',
        table: RUNTIME_ENVIRONMENT_SETUPS_TABLE,
        key: 'environment_id',
        row: (doc) => rowOf(SETUP_COLUMNS as DocumentTable<object>, doc),
        onConflict: replaceIfNewer('environment_id', 'updated_at'),
    },
    {
        collection: 'runtime_lessons',
        database: 'runtime',
        table: RUNTIME_LESSONS_TABLE,
        key: 'lesson_id',
        row: (doc) => rowOf(LESSON_COLUMNS as DocumentTable<object>, doc),
        onConflict: replaceIfNewer('lesson_id', 'last_at'),
    },
    {
        collection: 'runtime_publications',
        database: 'product',
        table: RUNTIME_PUBLICATIONS_TABLE,
        key: 'key',
        row: ({ request, ...doc }) => [...rowOf(PUBLICATION_COLUMNS as DocumentTable<object>, doc), { column: 'request', value: request ? jsonb(request) : null, json: true }],
        onConflict: () => 'DO NOTHING',
    },
    {
        collection: 'runtime_pr_comments',
        database: 'product',
        table: RUNTIME_PR_COMMENTS_TABLE,
        key: 'organization_id, repository_id, pr_number',
        row: ({ comment, createPending, ...doc }) =>
            rowOf(SLOT_COLUMNS as DocumentTable<object>, doc, {
                comment: { value: comment ? jsonb(comment) : null, json: true },
                create_pending: { value: createPending ? true : null },
            }),
        onConflict: () => 'DO NOTHING',
    },
];

const required = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
};

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const mongo = await MongoClient.connect(required('RUNTIME_BACKFILL_MONGO_URL'));
    const runtime = new Pool({ connectionString: required('RUNTIME_DATABASE_URL'), max: 2 });
    const productUrl = process.env.RUNTIME_BACKFILL_PRODUCT_DATABASE_URL;
    const product = productUrl ? new Pool({ connectionString: productUrl, max: 2 }) : undefined;
    let failed = 0;
    try {
        if (!dryRun) {
            const applied = await ensureRuntimeSchema(runtime);
            if (applied.length) console.log(`Runtime migrations applied: ${applied.join(', ')}`);
        }
        const db = mongo.db(process.env.RUNTIME_BACKFILL_MONGO_DB || undefined);
        for (const t of TARGETS) {
            const pg = t.database === 'runtime' ? runtime : product;
            if (!pg) {
                console.log(`${t.collection}: skipped (RUNTIME_BACKFILL_PRODUCT_DATABASE_URL is not set)`);
                continue;
            }
            if (!dryRun && !(await pg.query('SELECT to_regclass($1) AS t', [t.table])).rows[0].t) {
                throw new Error(`${t.table} does not exist: ${t.database === 'runtime' ? 'the Runtime migrations did not run' : 'run the product migrations (the API applies them at boot) first'}`);
            }
            let read = 0;
            let written = 0;
            for await (const raw of db.collection(t.collection).find({})) {
                read++;
                const { _id, ...doc } = raw as Record<string, unknown>;
                try {
                    const row = t.row(doc);
                    if (dryRun) continue;
                    const cols = row.map((c) => c.column);
                    const res = await pg.query(
                        `INSERT INTO ${t.table} AS t (${cols.join(', ')})
                         VALUES (${row.map((c, i) => (c.json ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
                         ON CONFLICT (${t.key}) ${t.onConflict(cols)}`,
                        row.map((c) => c.value),
                    );
                    written += res.rowCount ?? 0;
                } catch (e) {
                    failed++;
                    console.error(`${t.collection} ${String(_id)}: not copied (${(e as Error).message})`);
                }
            }
            console.log(`${t.collection} → ${t.table}: ${read} read, ${dryRun ? 'dry run, nothing written' : `${written} inserted or updated`}`);
        }
    } finally {
        await mongo.close();
        await runtime.end();
        await product?.end();
    }
    if (failed) {
        console.error(`${failed} document(s) not copied`);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
