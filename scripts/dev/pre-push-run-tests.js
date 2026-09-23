#!/usr/bin/env node

// Pre-push gate: runs only the tests affected by this branch. The full suite
// (with Postgres) runs on every PR in .github/workflows/tests.yml; running it
// here too cost ~23min and failed in any checkout without a local database.
//
//   PRE_PUSH_FULL=1 git push   → run the whole suite instead

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const dotenv = require('dotenv');

const BASE_REF = 'origin/main';

// Changes that can break tests the dependency graph does not point at.
const FULL_SUITE_TRIGGERS = [
    /^jest\.config\.ts$/,
    /^test\/jest\.setup\.ts$/,
    /^tsconfig.*\.json$/,
    /^(apps\/web\/)?package\.json$/,
    /^(apps\/web\/)?pnpm-lock\.yaml$/,
];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function mergeBase() {
    try {
        return git('merge-base', 'HEAD', BASE_REF);
    } catch {
        return null;
    }
}

function changedFiles(base) {
    return git('diff', '--name-only', `${base}...HEAD`)
        .split('\n')
        .filter(Boolean);
}

// What the integration specs see after their `require('dotenv').config()`:
// .env values, with the shell environment winning. Read here without being
// loaded into the env jest inherits, so no other test sees .env earlier.
function specEnv() {
    let fileVars = {};
    try {
        fileVars = dotenv.parse(fs.readFileSync('.env'));
    } catch {
        // no .env: the specs see only the shell environment too
    }
    return { ...fileVars, ...process.env };
}

// Same connection check as the integration specs: log in with their
// credentials and run SELECT 1. An open port is not enough; another
// project's Postgres on 5432 answers TCP but rejects these credentials,
// and the specs would then fail instead of skipping.
async function isPostgresReachable() {
    const { Client } = require('pg');
    // Resolved exactly like the specs (`??` + parseInt). A value they can't
    // use (e.g. TEST_PG_PORT= → NaN) means they can't run.
    const env = specEnv();
    const host = env.TEST_PG_HOST ?? 'localhost';
    const port = parseInt(env.TEST_PG_PORT ?? env.API_PG_DB_PORT ?? '5432', 10);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        console.warn(
            `[pre-push] TEST_PG_HOST/TEST_PG_PORT resolve to "${host}:${port}", which the integration specs can't use.`,
        );
        return false;
    }
    const client = new Client({
        host,
        port,
        user: env.TEST_PG_USER ?? env.API_PG_DB_USERNAME ?? 'kodusdev',
        password: env.TEST_PG_PASSWORD ?? env.API_PG_DB_PASSWORD ?? 'kodusdev',
        database: env.TEST_PG_DB ?? env.API_PG_DB_DATABASE ?? 'kodus_db',
        connectionTimeoutMillis: 2000,
    });
    try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
    } catch (error) {
        console.warn(
            `[pre-push] Postgres at ${host}:${port}: ${error.message}`,
        );
        return false;
    } finally {
        await client.end().catch(() => {});
    }
}

async function main() {
    const startTime = Date.now();
    const jestArgs = [];

    const base = mergeBase();
    const files = base ? changedFiles(base) : [];
    const trigger = files.find((f) =>
        FULL_SUITE_TRIGGERS.some((re) => re.test(f)),
    );

    if (process.env.PRE_PUSH_FULL === '1') {
        console.log('[pre-push] PRE_PUSH_FULL=1, running the full suite.');
    } else if (!base) {
        console.log(
            `[pre-push] No merge base with ${BASE_REF}, running the full suite.`,
        );
    } else if (trigger) {
        console.log(`[pre-push] ${trigger} changed, running the full suite.`);
    } else {
        console.log(
            `[pre-push] Running tests affected since ${BASE_REF} (${base.slice(0, 9)}).`,
        );
        jestArgs.push(`--changedSince=${base}`, '--passWithNoTests');
    }

    const env = { ...process.env };
    if (env.SKIP_INTEGRATION !== 'true' && !(await isPostgresReachable())) {
        console.warn(
            '[pre-push] Postgres not reachable, skipping integration specs (CI runs them). ' +
                'Start it with `pnpm run docker:up:infra` to include them.',
        );
        env.SKIP_INTEGRATION = 'true';
    }

    const child = spawn('pnpm', ['run', 'test', ...jestArgs], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
        env,
    });

    child.on('error', (error) => {
        console.error('[pre-push] Failed to start tests:', error.message);
        process.exit(1);
    });

    child.on('close', (code) => {
        const durationSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

        if (code === 0) {
            console.log(
                `[pre-push] Tests finished successfully in ${durationSeconds}s. Proceeding with push.`,
            );
            process.exit(0);
        }

        console.error(
            `[pre-push] Tests failed in ${durationSeconds}s. Push was blocked.`,
        );
        process.exit(code || 1);
    });
}

main().catch((error) => {
    console.error('[pre-push] Failed to run tests:', error.message);
    process.exit(1);
});
