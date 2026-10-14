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
// one-case run the smoke records: dependency versions and the harness that
// builds the record itself (loaded by the smoke's parent process, which isn't
// traced). A change to how the watch list is made gets measured once, instead
// of possibly never.
const NIGHTLY_EXTRA_FILES = [
    'pnpm-lock.yaml',
    'evals/wiring-smoke.js',
    'evals/shared/trace-loaded.js',
    'evals/shared/engine-files.js',
];

// Each eval the nightly measures, by its runner: a trace that does not list the
// runner is incomplete. With it, the eval's own files that change its verdict
// without being loaded by the one-case run (its floors, its verdict script).
const NIGHTLY_EVALS = {
    'evals/investigation/run-recall.js': ['evals/investigation/targets.json'],
    'evals/kody-rules/real-agent.js': ['evals/kody-rules/kody-targets.json', 'evals/kody-rules/nightly-verdict.js'],
};
const FINDER_RUNNER = 'evals/investigation/run-recall.js';

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

function changedEngineFiles(changedFiles, engineFiles, runner = FINDER_RUNNER) {
    const watched = new Set([...engineFiles, ...NIGHTLY_EXTRA_FILES, ...(NIGHTLY_EVALS[runner] || [])]);
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

module.exports = { globToRegExp, uncovered, changedEngineFiles, readTrace, NIGHTLY_EXTRA_FILES, NIGHTLY_EVALS };

// node evals/shared/engine-files.js changed <engine-files.txt> <changed-files.txt> [--runner=<eval runner>]
// Prints the changed files that the nightly measures for that eval (default:
// finder-recall), one per line.
if (require.main === module) {
    const [mode, engineList, changedList] = process.argv.slice(2);
    const runner = (process.argv.find((a) => a.startsWith('--runner=')) || `--runner=${FINDER_RUNNER}`).slice('--runner='.length);
    if (mode !== 'changed' || !engineList || !changedList || !NIGHTLY_EVALS[runner]) {
        console.error(`usage: node evals/shared/engine-files.js changed <engine-files.txt> <changed-files.txt> [--runner=${Object.keys(NIGHTLY_EVALS).join('|')}]`);
        process.exit(2);
    }
    const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const engineFiles = lines(engineList);
    if (!engineFiles.includes(runner) || !engineFiles.some((file) => file.startsWith('libs/'))) {
        console.error(`${engineList} does not list ${runner} and the engine it loads — the trace is incomplete; refusing to decide`);
        process.exit(2);
    }
    for (const file of changedEngineFiles(lines(changedList), engineFiles, runner)) console.log(file);
}
