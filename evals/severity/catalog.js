// Cases come from evals/secondary/datasets/*.json, the committed set severity/run.js reads: one case per PR with findings, its expected labels from the eval's heuristic judge.
const fs = require('fs');
const path = require('path');
const { MAX_TEXT } = require('../shared/eval-result');
const { RANK, heuristicJudgeSeverity } = require('./severity-eval');

const DATA = path.join(__dirname, '../secondary/datasets');

// head + middle + tail in at most MAX_TEXT characters, trimming the middle.
function fit(head, middle, tail) {
    const room = MAX_TEXT - head.length - tail.length;
    if (middle.length <= room) return head + middle + tail;
    const hard = middle.slice(0, Math.max(0, room - 1));
    const soft = hard.replace(/\s+\S*$/, ''); // whole words, unless that loses too much
    const cut = (soft.length >= hard.length * 0.6 ? soft : hard).replace(/[\s,;:.—-]+$/, '');
    return `${head}${cut}…${tail}`;
}

// "2 high, 1 low": the judge's labels, most severe first.
function labelCounts(labels) {
    const counts = {};
    for (const l of labels) counts[l] = (counts[l] || 0) + 1;
    return Object.keys(counts)
        .sort((a, b) => (RANK[b] ?? -1) - (RANK[a] ?? -1))
        .map((l) => `${counts[l]} ${l}`)
        .join(', ');
}

function catalog() {
    return fs
        .readdirSync(DATA)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')))
        .filter((ds) => (ds.findings || []).length)
        .map((ds) => {
            const n = ds.findings.length;
            const judge = labelCounts(ds.findings.map(heuristicJudgeSeverity));
            return {
                id: ds.prId,
                checks: fit(
                    `Checks reclassifying the ${n} finding${n === 1 ? '' : 's'} of the `,
                    ds.prId.replace(/[-_]+/g, ' '),
                    ` PR (judge: ${judge}) drops none below the high filter.`,
                ),
            };
        });
}

module.exports = { catalog };
