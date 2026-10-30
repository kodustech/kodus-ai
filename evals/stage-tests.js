#!/usr/bin/env node
// The unit tests of every review stage (evals/stages.js `tests` of kind
// `unit`), run once with jest so the quality panel can show, per stage, which
// tests it has and whether they pass. The nightly runs it on main; the rows come
// from evals/stage-signals.js --tests.
//
//   node evals/stage-tests.js --out=<jest.json>
//
// The specs need no database: they run in the nightly's job, which has none.
// Exit: 0 jest ran (its own failures are in the file, for the rows), 2 it wrote
// no results.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { unitSpecs } = require('./stages');

const ROOT = path.join(__dirname, '..');

function main() {
    const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice('--out='.length);
    if (!out) {
        console.error('usage: stage-tests.js --out=<jest.json>');
        return 2;
    }
    const specs = unitSpecs();
    const missing = specs.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    if (missing.length) console.error(`not on disk, reported as not run: ${missing.join(', ')}`);
    const present = specs.filter((f) => !missing.includes(f));
    const jest = path.join(ROOT, 'node_modules', '.bin', 'jest');
    const result = spawnSync(jest, ['--config', 'jest.config.ts', '--forceExit', '--no-coverage', '--json', `--outputFile=${path.resolve(out)}`, '--runTestsByPath', ...present], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, API_NODE_ENV: 'test', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=4096`.trim() },
    });
    if (!fs.existsSync(out)) {
        console.error(`jest wrote no results (exit ${result.status})`);
        return 2;
    }
    return 0;
}

if (require.main === module) process.exit(main());
