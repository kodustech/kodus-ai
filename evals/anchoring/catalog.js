// Cases come from evals/investigation/datasets/*.json, the files anchor-eval.js reads (first test case of each, in the name order it takes its --limit prefix from).
const fs = require('fs');
const path = require('path');
const { MAX_TEXT, MAX_CATALOG } = require('../shared/eval-result');

const DATA = path.join(__dirname, '../investigation/datasets');

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

// What anchor-eval.js runs per file: `[0].vars` of each dataset, sorted by name.
function cases() {
    return fs
        .readdirSync(DATA)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort()
        .map((f) => {
            const vars = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'))[0].vars;
            const files = parseMaybe(vars.changedFiles);
            return {
                id: f.replace(/\.json$/, ''),
                repo: vars.repositoryFullName || 'eval/repo',
                title: String(vars.prTitle || vars.caseId || f).trim(),
                files: Array.isArray(files) ? files.length : 0,
            };
        });
}

function catalog() {
    const all = cases();
    if (all.length > MAX_CATALOG) {
        const byRepo = new Map();
        for (const c of all) byRepo.set(c.repo, (byRepo.get(c.repo) || 0) + 1);
        return [...byRepo].map(([repo, count]) => ({
            id: repo,
            group: repo,
            count,
            checks: `Checks the finder's findings on ${count} ${repo} PRs anchor onto diff lines, with no near-miss drop.`,
        }));
    }
    return all.map((c) => ({
        id: c.id,
        checks: fit(
            'Checks findings on "',
            c.title,
            `" (${c.repo}, ${c.files} changed file${c.files === 1 ? '' : 's'}) anchor onto diff lines, no near-miss drop.`,
        ),
    }));
}

module.exports = { catalog };
