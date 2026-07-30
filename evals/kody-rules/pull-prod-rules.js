/**
 * Export kody-rules from a Mongo instance into the gitignored prod-rules.json
 * that backfill-shipped.js / prod-rules-judge-eval.js read.
 *
 * RUN IT YOURSELF (you hold the prod credential; this is customer data):
 *   MONGO_URI='mongodb+srv://…' node evals/kody-rules/pull-prod-rules.js [--limit=1000] [--collection=kodyRules] [--db=kodus]
 *
 * Reads the URI from MONGO_URI (or API_MONGO_DB_URI). Never hardcode it and
 * never commit the output — prod-rules.json is gitignored. --limit takes the
 * first N flattened rules (omit for all). Prints only counts, never rule
 * contents or the URI.
 */
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const COLLECTION = args.collection || 'kodyRules';
const DB = args.db || undefined; // undefined → db from the URI

const uri = process.env.MONGO_URI || process.env.API_MONGO_DB_URI;
if (!uri) {
    console.error(
        'Set MONGO_URI (or API_MONGO_DB_URI) to the prod connection string. Aborting.',
    );
    process.exit(1);
}

(async () => {
    let MongoClient;
    try {
        ({ MongoClient } = require('mongodb'));
    } catch {
        console.error(
            'The `mongodb` package is required. Try: pnpm add -D mongodb  (or run from a dir that has it).',
        );
        process.exit(1);
    }

    const client = new MongoClient(uri);
    await client.connect();
    try {
        const db = client.db(DB);
        const docs = await db.collection(COLLECTION).find({}).toArray();

        // One doc per org, each with an embedded rules[] array — flatten, keeping
        // only the fields the evals use (NO teamId/repositoryId/org ids kept).
        const rules = [];
        let orgs = 0;
        for (const d of docs) {
            if (!Array.isArray(d.rules)) continue;
            orgs++;
            for (const r of d.rules) {
                if (!r || !r.rule) continue;
                rules.push({
                    uuid: r.uuid,
                    title: r.title,
                    type: r.type,
                    status: r.status,
                    scope: r.scope,
                    path: r.path,
                    sourcePath: r.sourcePath,
                    rule: r.rule,
                    examples: r.examples,
                });
                if (rules.length >= LIMIT) break;
            }
            if (rules.length >= LIMIT) break;
        }

        const out = path.join(__dirname, 'prod-rules.json');
        fs.writeFileSync(out, JSON.stringify(rules, null, 1));

        const byStatus = {};
        const withExamples = rules.filter(
            (r) => Array.isArray(r.examples) && r.examples.length,
        ).length;
        for (const r of rules)
            byStatus[r.status || 'unknown'] =
                (byStatus[r.status || 'unknown'] || 0) + 1;
        console.log(`Wrote ${rules.length} rules from ${orgs} orgs → ${out}`);
        console.log(`  by status: ${JSON.stringify(byStatus)}`);
        console.log(`  with examples (gate-testable): ${withExamples}`);
        console.log(
            `\nprod-rules.json is gitignored — do NOT commit it. Now run:\n  node evals/kody-rules/backfill-shipped.js --model=gpt-5.4-mini`,
        );
    } finally {
        await client.close();
    }
})().catch((e) => {
    console.error('Export failed:', e.message);
    process.exit(2);
});
