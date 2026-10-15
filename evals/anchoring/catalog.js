// Cases come from evals/investigation/datasets/*.json as anchor-eval.js selects them (selection.js): the first test case of each.
const fs = require('fs');
const path = require('path');
const { MAX_TEXT } = require('../shared/eval-result');
const { DATASETS_DIR, DEFAULT_LIMIT, datasetFiles } = require('./selection');


// head + middle + tail in at most MAX_TEXT characters, trimming the middle.
function fit(head, middle, tail) {
    const room = MAX_TEXT - head.length - tail.length;
    if (middle.length <= room) return head + middle + tail;
    const hard = middle.slice(0, Math.max(0, room - 1));
    const soft = hard.replace(/\s+\S*$/, ''); // whole words, unless that loses too much
    const cut = (soft.length >= hard.length * 0.6 ? soft : hard).replace(/[\s,;:.—-]+$/, '');
    return `${head}${cut}…${tail}`;
}

const parseMaybe = (v) => {
    if (typeof v !== 'string') return v;
    try {
        return JSON.parse(v);
    } catch {
        return v;
    }
};

// The cases a default run covers (the first DEFAULT_LIMIT datasets, sorted,
// selection.js), then the rest as one group a larger --limit reaches. A dataset
// that does not parse is skipped, as recall-tests.js does.
function cases(files) {
    return files
        .map((f) => {
            let vars;
            try {
                vars = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, f), 'utf8'))[0].vars;
            } catch {
                return null;
            }
            if (!vars) return null;
            const changed = parseMaybe(vars.changedFiles);
            return {
                id: f.replace(/\.json$/, ''),
                repo: vars.repositoryFullName || 'eval/repo',
                title: String(vars.prTitle || vars.caseId || f).trim(),
                files: Array.isArray(changed) ? changed.length : 0,
            };
        })
        .filter(Boolean);
}

function catalog() {
    const all = datasetFiles();
    const run = cases(all.slice(0, DEFAULT_LIMIT)).map((c) => ({
        id: c.id,
        checks: fit(
            'Checks findings on "',
            c.title,
            `" (${c.repo}, ${c.files} changed file${c.files === 1 ? '' : 's'}) anchor onto diff lines, no near-miss drop.`,
        ),
    }));
    const rest = all.length - DEFAULT_LIMIT;
    if (rest <= 0) return run;
    return [
        ...run,
        { id: 'with-larger-limit', group: 'with --limit', count: rest, checks: `Checks the same on ${rest} more PRs when run with a larger --limit (the next datasets by name).` },
    ];
}

module.exports = { catalog };
