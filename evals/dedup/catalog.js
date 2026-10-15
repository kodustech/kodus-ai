// Cases come from evals/secondary/datasets/*.json, the committed set dedup/run.js falls back to when evals/dedup/datasets/ (gitignored) is absent: one case per PR with 2+ findings.
const fs = require('fs');
const path = require('path');
const { MAX_TEXT } = require('../shared/eval-result');

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

function catalog() {
    return fs
        .readdirSync(DATA)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')))
        .filter((ds) => (ds.findings || []).length >= 2) // run.js: fewer than 2 = nothing to dedup
        .map((ds) => {
            const g = (ds.goldenComments || []).length;
            const covered = g === 1 ? 'its one golden bug' : g === 2 ? 'both its golden bugs' : `all ${g} golden bugs`;
            return {
                id: ds.prId,
                checks: fit(
                    `Checks dedup of the ${ds.findings.length} findings of the `,
                    ds.prId.replace(/[-_]+/g, ' '),
                    ` PR still covers ${covered} after merging.`,
                ),
            };
        });
}

module.exports = { catalog };
