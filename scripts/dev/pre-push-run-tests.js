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
        // The specs see only the shell environment too, so they would fall
        // back to the same defaults; say so instead of skipping silently.
        console.warn(
            '[pre-push] No .env here (fresh worktree?): Postgres credentials fall back to the defaults. Run `pnpm run env:pull`.',
        );
    }
    return { ...fileVars, ...process.env };
}

// Same connection check as the integration specs: log in with their
// credentials and run SELECT 1. An open port is not enough; another
// project's Postgres on 5432 answers TCP but rejects these credentials,
// and the specs would then fail instead of skipping.
async function isPostgresReachable() {
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
    let Client;
    try {
        ({ Client } = require('pg'));
    } catch (error) {
        // a partial install must not block the push over a probe
        console.warn(
            `[pre-push] Can't load pg to probe Postgres: ${error.message}`,
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

/**
 * git writes the refs being pushed to the hook's stdin. Read it all first: a
 * test process that inherited the pipe and closed it left git writing to a
 * closed pipe, so the push died of SIGPIPE (exit 141) after every test passed.
 */
function drainStdin() {
    if (process.stdin.isTTY) return Promise.resolve();
    return new Promise((resolve) => {
        process.stdin.on('data', () => {});
        process.stdin.on('end', resolve);
        process.stdin.on('error', resolve);
        setTimeout(resolve, 5_000).unref();
    });
}

async function main() {
    await drainStdin();
    const startTime = Date.now();
    const jestArgs = [];
    let full = true;

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
        full = false;
    }

    // git exports GIT_DIR and friends to the hook it runs. Any spec that spawns
    // git with the inherited env then works on this repository instead of its
    // temp repos: commits land in its history, and `init`/`config` set
    // core.bare=true and core.hooksPath=/dev/null for every worktree.
    // Only what points git at a repository or injects config entries is
    // dropped; the developer's config sources and trust settings
    // (GIT_CONFIG_GLOBAL, GIT_SSL_*, GIT_SSH_COMMAND, GIT_EXEC_PATH) stay.
    const GIT_REDIRECT_ENV =
        /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|QUARANTINE_PATH|SHALLOW_FILE|PREFIX|CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+))$/;
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key]) => !GIT_REDIRECT_ENV.test(key),
        ),
    );
    if (env.SKIP_INTEGRATION !== 'true' && !(await isPostgresReachable())) {
        console.warn(
            '[pre-push] Postgres not reachable, skipping integration specs (CI runs them). ' +
                'Start it with `pnpm run docker:up:infra` to include them.',
        );
        env.SKIP_INTEGRATION = 'true';
    }

    // The full suite no longer fits one process's heap (it ran out at 6 GB),
    // which is why CI shards it (tests.yml, 4 shards). Here the shards run one
    // after the other, each in a fresh process; the first failure stops. 8 by
    // default: a quarter of the suite still ran out of heap on a laptop.
    const shards = full ? Math.max(1, Number(process.env.PRE_PUSH_SHARDS) || 8) : 1;
    let code = 0;
    for (let i = 1; i <= shards && code === 0; i++) {
        const args = shards > 1 ? [...jestArgs, `--shard=${i}/${shards}`] : jestArgs;
        if (shards > 1) console.log(`[pre-push] Shard ${i}/${shards}.`);
        code = await runTests(args, env);
    }
    {
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
    }
}

/** `pnpm run test` with these jest args; resolves with its exit code. */
function runTests(jestArgs, env) {
    return new Promise((resolve) => {
        const child = spawn('pnpm', ['run', 'test', ...jestArgs], {
            // Never the hook's stdin (git's refs pipe): see drainStdin.
            stdio: ['ignore', 'inherit', 'inherit'],
            shell: process.platform === 'win32',
            env,
        });
        child.on('error', (error) => {
            console.error('[pre-push] Failed to start tests:', error.message);
            resolve(1);
        });
        child.on('close', (code) => resolve(code ?? 1));
    });
}

main().catch((error) => {
    console.error('[pre-push] Failed to run tests:', error.message);
    process.exit(1);
});
