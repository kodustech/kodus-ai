// Which repo files an eval really depends on, measured instead of listed.
//
// Hand-written path lists drifted: the nightly watched libs/code-review and
// libs/llm while finder-recall also loads libs/core, libs/common, libs/identity
// and more, so changes there were never measured. The wiring smoke now records
// every repo file each eval step loads (require + readFileSync, via
// `trace-loaded.js`) and uses that record twice:
//   - the nightly measures only if one of those files changed since the last
//     green night (`changedEngineFiles`);
//   - the smoke fails if a loaded file falls outside the PR workflow's
//     `paths` filter (`uncovered`), so the PR check can't silently stop firing.
const fs = require('fs');
const path = require('path');

// Files that change what the nightly measures without being loaded by the
// one-case run the smoke records: dependency versions and the floors.
const NIGHTLY_EXTRA_FILES = ['pnpm-lock.yaml', 'evals/investigation/targets.json'];

// Local env files are read when present but are never part of the repo.
const IGNORED = /^\.env(\..*)?$/;

// GitHub `paths` glob → RegExp: `**` spans directories, `*` stays within one.
function globToRegExp(glob) {
    let source = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            source += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if (ch === '*') {
            source += '[^/]*';
        } else {
            source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`);
}

function uncovered(files, patterns) {
    const regexes = patterns.map(globToRegExp);
    return files.filter((file) => !IGNORED.test(file) && !regexes.some((re) => re.test(file)));
}

function changedEngineFiles(changedFiles, engineFiles) {
    const watched = new Set([...engineFiles, ...NIGHTLY_EXTRA_FILES]);
    return changedFiles.filter((file) => watched.has(file));
}

// Every repo file recorded by trace-loaded.js for runs labelled `label`
// (or all runs), sorted, env files dropped.
function readTrace(dir, label) {
    const files = new Set();
    for (const entry of fs.readdirSync(dir)) {
        if (label && !entry.startsWith(`${label}.`)) continue;
        for (const line of fs.readFileSync(path.join(dir, entry), 'utf8').split('\n')) {
            if (line && !IGNORED.test(line)) files.add(line);
        }
    }
    return [...files].sort();
}

module.exports = { globToRegExp, uncovered, changedEngineFiles, readTrace, NIGHTLY_EXTRA_FILES };

// node evals/shared/engine-files.js changed <engine-files.txt> <changed-files.txt>
// Prints the changed files that the nightly measures, one per line.
if (require.main === module) {
    const [mode, engineList, changedList] = process.argv.slice(2);
    if (mode !== 'changed' || !engineList || !changedList) {
        console.error('usage: node evals/shared/engine-files.js changed <engine-files.txt> <changed-files.txt>');
        process.exit(2);
    }
    const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const engineFiles = lines(engineList);
    const runner = 'evals/investigation/run-recall.js';
    if (!engineFiles.includes(runner) || !engineFiles.some((file) => file.startsWith('libs/'))) {
        console.error(`${engineList} does not list ${runner} and the engine it loads — the trace is incomplete; refusing to decide`);
        process.exit(2);
    }
    for (const file of changedEngineFiles(lines(changedList), engineFiles)) console.log(file);
}
