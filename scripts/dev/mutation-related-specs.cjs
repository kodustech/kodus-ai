#!/usr/bin/env node
// Specs that exercise the changed files, by jest's own dependency graph, nearest
// first and capped. Naming alone misses a spec that reaches a file through
// another module (a mapper tested through its index), and Stryker, with
// enableFindRelatedTests, then finds no test for that file and aborts. A hub file
// can relate to hundreds of specs, so the closest ones by directory win.
//
// Usage: mutation-related-specs.cjs <max> <changed-file>...
// Prints one repo-relative spec path per line. Exits non-zero, with jest's
// diagnostic, when jest cannot list the specs: that is not "no specs".
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX = 40;
const MAX_SUPPORTED = 200;
let max = Number(process.argv[2]);
if (!Number.isInteger(max) || max < 0 || max > MAX_SUPPORTED) {
    console.error(
        `[mutation:diff] MUTATION_MAX_RELATED_SPECS=${process.argv[2]} is not an integer from 0 to ${MAX_SUPPORTED}; using ${DEFAULT_MAX}.`,
    );
    max = DEFAULT_MAX;
}
const files = process.argv.slice(3);
if (!files.length || max === 0) process.exit(0);

let output = '';
try {
    output = execFileSync(
        process.execPath,
        [
            'node_modules/jest/bin/jest.js',
            '--listTests',
            '--findRelatedTests',
            ...files,
        ],
        {
            encoding: 'utf8',
            env: { ...process.env, API_NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
            maxBuffer: 64 * 1024 * 1024,
        },
    );
} catch (error) {
    // jest exits 0 with an empty list when nothing relates; a non-zero exit is
    // a config or resolution failure, which must not pass as "no specs".
    process.stderr.write(String(error.stderr ?? error.message ?? error));
    console.error('[mutation:diff] jest could not list the related specs.');
    process.exit(1);
}

const root = process.cwd();
const dirs = files.map((file) => path.dirname(file).split('/'));
const closeness = (spec) => {
    const parts = path.dirname(spec).split('/');
    return Math.max(
        ...dirs.map((dir) => {
            let shared = 0;
            while (shared < dir.length && dir[shared] === parts[shared]) {
                shared++;
            }
            return shared;
        }),
    );
};

const specs = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((abs) => path.relative(root, abs))
    .filter((spec) => !spec.startsWith('..'));

// This job starts no database and runs under SKIP_INTEGRATION=true
// (mutation-diff.sh), so a database-backed integration spec skips itself: it
// loads and kills nothing. Those go last, so they only take a slot of the cap
// that no spec that runs wants. A wrong guess costs a position, not a spec.
const skipsItself = (spec) => {
    if (!/\.integration\.spec\.ts$/.test(spec)) return false;
    try {
        // The gate as code — reading the variable or calling the Mongo gate —
        // with comments stripped, so a spec that only mentions it still runs
        // in its own position.
        const code = fs
            .readFileSync(spec, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        return /process\.env\.SKIP_INTEGRATION\b|resolveMongoTestGate\s*\(/.test(
            code,
        );
    } catch {
        return false;
    }
};

specs
    .map((spec) => ({
        spec,
        closeness: closeness(spec),
        skipped: skipsItself(spec),
    }))
    .sort(
        (a, b) =>
            a.skipped - b.skipped ||
            b.closeness - a.closeness ||
            a.spec.localeCompare(b.spec),
    )
    .slice(0, max)
    .forEach(({ spec }) => console.log(spec));
