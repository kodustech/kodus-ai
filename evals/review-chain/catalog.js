// Cases come from BOUNDARIES exported by run.js (the wiring ledger, plus its discovery scan) and the PAYLOADS x ENCODINGS tables of shape-invariance.js, read as text because requiring that file runs the eval.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { MAX_TEXT } = require('../shared/eval-result');
const { BOUNDARIES } = require('./run');

// head + middle + tail in at most MAX_TEXT characters, trimming the middle.
function fit(head, middle, tail) {
    const room = MAX_TEXT - head.length - tail.length;
    if (middle.length <= room) return head + middle + tail;
    const hard = middle.slice(0, Math.max(0, room - 1));
    const soft = hard.replace(/\s+\S*$/, ''); // whole words, unless that loses too much
    const cut = (soft.length >= hard.length * 0.6 ? soft : hard).replace(/[\s,;:.—-]+$/, '');
    return `${head}${cut}…${tail}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The resilience floors run.js knows (`requires`), as a reader would say them.
const FLOOR = {
    schema: 'a schema on the structured executor',
    shape: 'the shared shape layer',
    recover: 'envelope-shape recovery',
};

// The reason a boundary's note gives, up to its first dash; parentheticals go
// when the sentence would not fit otherwise.
function reason(note, room) {
    const head = String(note || '').split(' — ')[0].trim();
    return head.length <= room ? head : head.replace(/\s*\([^()]*\)/g, '');
}

function boundaryCase(b) {
    if (b.declined || b.accepted) {
        const head = b.declined ? `Checks the ${b.phase} call stays out of output recovery by design: ` : `Tracks the ${b.phase} call as accepted and not gated: `;
        return { id: b.phase, group: 'wiring', checks: fit(head, reason(b.note, MAX_TEXT - head.length - 1), '.') };
    }
    const floors = b.requires.map((r) => FLOOR[r] || r).join(' and ');
    return { id: b.phase, group: 'wiring', checks: fit(`Checks the ${b.phase} LLM call still routes its output through `, floors, '.') };
}

// The directories the discovery scan greps, as run.js spells them.
function discoveryCase() {
    const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    const dirs = (src.match(/--include='\*\.ts' ([^`]+?)\s*`/) || [])[1];
    const where = dirs ? `under ${dirs.trim().split(/\s+/).join(', ')} ` : 'in the review chain ';
    return {
        id: 'undeclared-call-sites',
        group: 'wiring',
        checks: fit('Checks every LLM call site ', where, `is claimed by one of the ${BOUNDARIES.length} manifest entries.`),
    };
}

// PAYLOADS and ENCODINGS as shape-invariance.js declares them.
function shapeTables() {
    const src = fs.readFileSync(path.join(__dirname, 'shape-invariance.js'), 'utf8');
    const table = (name) => {
        const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`));
        if (!m) throw new Error(`review-chain catalog: ${name} not found in shape-invariance.js`);
        return vm.runInNewContext(`(${m[1]})`);
    };
    const key = (src.match(/const KEY = '([^']+)'/) || [])[1] || 'key';
    return { key, payloads: table('PAYLOADS'), encodings: table('ENCODINGS') };
}

function shapeCases() {
    const { key, payloads, encodings } = shapeTables();
    const n = Object.keys(payloads).length;
    return Object.keys(encodings).map((enc) => ({
        id: `shape/${slug(enc)}`,
        group: 'shape-invariance',
        count: n,
        checks: fit(`Checks all ${n} payloads encoded as `, enc.replace(/\bkey\b/g, key), ` normalize to {${key}:D}, the canonical envelope.`),
    }));
}

function catalog() {
    return [...BOUNDARIES.map(boundaryCase), discoveryCase(), ...shapeCases()];
}

module.exports = { catalog };
