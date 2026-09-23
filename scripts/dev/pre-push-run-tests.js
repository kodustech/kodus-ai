#!/usr/bin/env node

// Pre-push gate: runs only the tests affected by this branch. The full suite
// (with Postgres) runs on every PR in .github/workflows/tests.yml; running it
// here too cost ~23min and failed in any checkout without a local database.
//
//   PRE_PUSH_FULL=1 git push   → run the whole suite instead

const { spawn, execFileSync } = require('child_process');
const net = require('net');

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

// Same host/port resolution as the integration specs.
function isPostgresReachable() {
    // `||`, not `??`: an empty TEST_PG_PORT= must fall through to the default.
    const host = process.env.TEST_PG_HOST || 'localhost';
    const port = Number(
        process.env.TEST_PG_PORT || process.env.API_PG_DB_PORT || '5432',
    );
    // net.connect throws synchronously on a bad port; treat it as unreachable.
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(1000, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
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
