/**
 * @file redact-leaked-passwords.ts
 *
 * One-shot remediation script for issue #817.
 *
 * Finds all observability log entries where the MongoDB password was stored in
 * plaintext inside `attributes.config.password` and either redacts or deletes them.
 *
 * Safe to run multiple times — documents already redacted are skipped.
 *
 * Usage:
 *   npx tsx scripts/redact-leaked-passwords.ts [--dry-run] [--delete] [--env .env.prod]
 *
 *   --dry-run   Show affected documents without making changes.
 *   --delete    Delete documents instead of redacting credentials.
 *   --env FILE  Load a specific env file (default: .env).
 */

import { MongoClient } from 'mongodb';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load .env before anything else
// ---------------------------------------------------------------------------

const envFlagIndex = process.argv.indexOf('--env');
const envFile =
    envFlagIndex !== -1 && process.argv[envFlagIndex + 1]
        ? process.argv[envFlagIndex + 1]
        : '.env';

const envPath = resolve(process.cwd(), envFile);
const { error: envError } = loadEnv({ path: envPath });

if (envError) {
    console.warn(`⚠️  Could not load env file "${envPath}": ${envError.message}`);
} else {
    console.log(`✅  Loaded env from: ${envPath}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN    = process.argv.includes('--dry-run');
const DO_DELETE  = process.argv.includes('--delete');

const LOG_COLLECTION  = 'observability_logs_ts';

// Messages written by ObservabilityService that leaked the password.
const AFFECTED_MESSAGES = [
    'Observability initialized',
    'Error initializing observability',
];

// ---------------------------------------------------------------------------
// Connection string (mirrors ObservabilityService.buildConnectionString)
// ---------------------------------------------------------------------------

function buildConnectionString(): string {
    const host     = process.env.API_MG_DB_HOST;
    const port     = process.env.API_MG_DB_PORT;
    const username = process.env.API_MG_DB_USERNAME;
    const password = process.env.API_MG_DB_PASSWORD;

    if (!host) throw new Error('API_MG_DB_HOST is not set');

    const auth   = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password ?? '')}@` : '';
    const proto  = port ? 'mongodb' : 'mongodb+srv';
    const portSuffix = port ? `:${port}` : '';

    let uri = `${proto}://${auth}${host}${portSuffix}`;

    const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
    const isProduction = env && !['development', 'test'].includes(env);
    const productionConfig = process.env.API_MG_DB_PRODUCTION_CONFIG;

    if (isProduction && productionConfig) {
        uri = `${uri}/${productionConfig}`;
    }

    return uri;
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

const CENSOR = '[REDACTED]';

/**
 * Returns an update pipeline that redacts credentials from `attributes.config`.
 * Only applied when fields exist and are not already redacted.
 */
function buildUpdatePipeline() {
    return [
        {
            $set: {
                'attributes.config.password': CENSOR,
                'attributes.config.username': CENSOR,
            },
        },
    ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const database = process.env.API_MG_DB_DATABASE;
    if (!database) throw new Error('API_MG_DB_DATABASE is not set');

    const uri    = buildConnectionString();
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db  = client.db(database);
        const col = db.collection(LOG_COLLECTION);

        // Find documents that:
        //   1. Are one of the affected log messages, AND
        //   2. Have attributes.config.password OR attributes.config.username not yet redacted.
        const filter = {
            message: { $in: AFFECTED_MESSAGES },
            $or: [
                { 'attributes.config.password': { $exists: true, $ne: CENSOR } },
                { 'attributes.config.username': { $exists: true, $ne: CENSOR } },
            ],
        };

        const count = await col.countDocuments(filter);

        if (count === 0) {
            console.log('✅  No affected documents found. Nothing to redact.');
            return;
        }

        const action = DO_DELETE ? 'delete' : 'redact';
        console.log(`🔍  Found ${count} document(s) with plaintext credentials. Action: ${action}.`);

        if (DRY_RUN) {
            console.log('ℹ️   --dry-run mode: no changes written.');

            // Print a sample to confirm the query is correct.
            const sample = await col.find(filter).limit(3).toArray();
            for (const doc of sample) {
                console.log(JSON.stringify({
                    _id:      doc._id,
                    message:  doc.message,
                    level:    doc.level,
                    'attributes.config.username': doc.attributes?.config?.username,
                    'attributes.config.password': doc.attributes?.config?.password,
                }, null, 2));
            }
            return;
        }

        if (DO_DELETE) {
            const result = await col.deleteMany(filter);
            console.log(`✅  Deleted ${result.deletedCount} document(s) from "${LOG_COLLECTION}".`);
        } else {
            const result = await col.updateMany(filter, buildUpdatePipeline());
            console.log(`✅  Redacted ${result.modifiedCount} document(s) in "${LOG_COLLECTION}".`);
        }

        // Verify nothing was missed.
        const remaining = await col.countDocuments({
            message: { $in: AFFECTED_MESSAGES },
            $or: [
                { 'attributes.config.password': { $exists: true, $ne: CENSOR } },
                { 'attributes.config.username': { $exists: true, $ne: CENSOR } },
            ],
        });
        if (remaining > 0) {
            console.warn(`⚠️  ${remaining} document(s) still have plaintext credentials — investigate manually.`);
        } else {
            console.log('✅  Verification passed: no plaintext credentials remain.');
        }

    } finally {
        await client.close();
    }
}

main().catch((err) => {
    // Sanitize error message before printing — MongoDB errors can include the
    // connection URI which may contain credentials.
    const safeMessage = String(err?.message ?? err).replace(
        /([a-z][a-z0-9+\-.]*:\/\/[^:@\s]*:)([^@\s]+)(@)/gi,
        '$1[REDACTED]$3',
    );
    console.error('❌  Script failed:', safeMessage);
    process.exit(1);
});
