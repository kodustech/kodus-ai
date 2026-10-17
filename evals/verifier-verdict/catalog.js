// Cases come from fixtures.json `rows` (what run.js replays without --corpus) and the DEPTHS list of the finalize ledger in run.js, read as text because requiring run.js runs the eval.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MAX_TEXT } = require('../shared/eval-result');

// head + middle + tail in at most MAX_TEXT characters, trimming the middle.
function fit(head, middle, tail) {
    const room = MAX_TEXT - head.length - tail.length;
    if (middle.length <= room) return head + middle + tail;
    const hard = middle.slice(0, Math.max(0, room - 1));
    const soft = hard.replace(/\s+\S*$/, ''); // whole words, unless that loses too much
    const cut = (soft.length >= hard.length * 0.6 ? soft : hard).replace(/[\s,;:.—-]+$/, '');
    return `${head}${cut}…${tail}`;
}

// The delivery shape a row reproduces: its `source` up to the first sentence,
// without the `shape:` / `no \`expect\`:` lead and without parentheticals.
function shapeOf(source) {
    return String(source || '')
        .replace(/^shape:\s*/i, '')
        .replace(/^no `expect`:\s*/i, '')
        .replace(/\s*\([^)]*\)/g, '')
        .split(/\.\s/)[0]
        .replace(/\.$/, '')
        .trim();
}

// What the gate must do with the row, from its `expect` (or its absence).
function outcomeOf(row) {
    const hasText = Boolean(String(row.text || '').trim());
    const channel = row.calledVerdictTool ? 'sent through the verdict tool' : hasText ? 'written in the final text' : 'with no final text';
    if (!row.expect) return `a ${row.calledVerdictTool ? 'tool' : hasText ? 'text' : 'textless'} verdict with no fixed expectation is scored as delivered`;
    if (row.expect.keep === false) return `a refutation ${channel} drops the finding`;
    if (row.expect.parseMode === 'default-keep') return `a run that delivered no verdict${hasText ? '' : ' and no text'} fails open and keeps the finding`;
    return `a confirmation ${channel} keeps the finding`;
}

function fixtureCases() {
    const { rows } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
    return rows.map((row) => ({
        id: row.id,
        checks: fit(`Checks that ${outcomeOf(row)} (`, shapeOf(row.source), ').'),
    }));
}

// The depths the finalize ledger walks, as run.js declares them.
function ledgerCases() {
    const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    const m = src.match(/const DEPTHS = (\[[\s\S]*?\n\]);/);
    if (!m) throw new Error('verifier-verdict catalog: DEPTHS not found in run.js');
    const depths = vm.runInNewContext(m[1]);
    return depths.map(({ label, maxSteps }) => {
        const name = label.split(/\s+/)[0];
        const why = (label.match(/\(([^)]*)\)/) || [])[1];
        return {
            id: `finalize-ledger-${name}`,
            checks: fit(
                `Checks each last step of the verifier spec at ${name} depth (${maxSteps} steps`,
                why ? `; ${why}` : '',
                ') carries a finalize or budget nudge and never restricts tools.',
            ),
        };
    });
}

function catalog() {
    return [...fixtureCases(), ...ledgerCases()];
}

module.exports = { catalog };
