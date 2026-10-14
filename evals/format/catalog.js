// Cases come from evals/secondary/datasets/*.json, the committed set format/run.js reads: one case per PR with findings, its scaffold and identifier counts from the eval's own scorer.
const fs = require('fs');
const path = require('path');
const { MAX_TEXT } = require('../shared/eval-result');
const { extractIdents, scoreOne } = require('./format-eval');

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
        .filter((ds) => (ds.findings || []).length)
        .map((ds) => {
            const n = ds.findings.length;
            // Scoring a finding against itself says whether its original text
            // carries WHAT/WHY/HOW labels the formatter must remove.
            const scaffolded = ds.findings.filter((f) => !scoreOne(f, f).no_scaffold).length;
            const idents = ds.findings.reduce((a, f) => a + extractIdents(f.suggestionContent).size, 0);
            return {
                id: ds.prId,
                checks: fit(
                    `Checks formatting the ${n} suggestion${n === 1 ? '' : 's'} of the `,
                    ds.prId.replace(/[-_]+/g, ' '),
                    ` PR removes WHAT/WHY/HOW from ${scaffolded} and keeps ≥50% of their ${idents} identifiers.`,
                ),
            };
        });
}

module.exports = { catalog };
