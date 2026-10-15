#!/usr/bin/env node
// Which evals of evals/nightly-evals.js the nightly measures tonight: each one
// whose files changed since the last measured night (the wiring smoke's
// --eval-files-dir lists them per step), all of them when forced, when there is
// no night to compare with, or when the diff is unknown.
//
//   node evals/shared/nightly-plan.js --files-dir=<dir> [--changed=<changed-files.txt>] [--base=<sha>] [--force=true]
//
// Prints a JSON array of eval ids (the matrix of the shared job) on stdout and
// the reason for each on stderr. Exit 2 when a list is missing its runner: the
// trace is incomplete and nothing can be decided.
const fs = require('fs');
const path = require('path');
const { NIGHTLY_EVALS } = require('../nightly-evals');
const { changedEngineFiles } = require('./engine-files');

function arg(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

function plan({ filesDir, changedFile, base, force }) {
    const picked = [];
    const changed = changedFile && fs.existsSync(changedFile) ? lines(changedFile) : null;
    for (const e of NIGHTLY_EVALS) {
        const listFile = path.join(filesDir, `${e.id}.txt`);
        const files = fs.existsSync(listFile) ? lines(listFile) : [];
        if (!files.includes(e.run[0]) || !files.some((f) => f.startsWith('libs/'))) {
            throw new Error(`${listFile} does not list ${e.run[0]} and the engine it loads — the trace is incomplete; refusing to decide`);
        }
        let why;
        if (force) why = 'forced';
        else if (!base) why = 'no measured night to compare with';
        else if (!changed) why = `diff against ${base} unknown`;
        else {
            const hits = changedEngineFiles(changed, files, e.run[0]);
            if (hits.length) why = `${hits.length} of its files changed since ${base}: ${hits.slice(0, 5).join(', ')}`;
        }
        console.error(`${e.id}: ${why ? `measuring (${why})` : `none of its ${files.length} files changed since ${base} — skipping`}`);
        if (why) picked.push(e.id);
    }
    return picked;
}

function main() {
    try {
        const ids = plan({ filesDir: arg('files-dir'), changedFile: arg('changed'), base: arg('base'), force: arg('force') === 'true' });
        console.log(JSON.stringify(ids));
        return 0;
    } catch (error) {
        console.error(error.message);
        return 2;
    }
}

if (require.main === module) process.exit(main());

module.exports = { plan };
