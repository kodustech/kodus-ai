// The PRs the nightly runs (the `controlled` set in recall-tests.js), each named by
// its title, with the number of known bugs in its dataset.
const fs = require('fs');
const path = require('path');
const { CASE_SETS } = require('./recall-tests');

const DATASETS_DIR = path.join(__dirname, 'datasets');

function catalog(set = 'controlled') {
    const wanted = new Set(CASE_SETS[set]);
    const entries = [];
    for (const file of fs.readdirSync(DATASETS_DIR).filter((f) => f.endsWith('.json'))) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, file), 'utf8'));
        } catch {
            continue;
        }
        const vars = (Array.isArray(raw) ? raw[0] : raw)?.vars;
        if (!vars || !wanted.has(vars.caseId)) continue;
        const goldens = typeof vars.goldenComments === 'string' ? JSON.parse(vars.goldenComments) : vars.goldenComments || [];
        const title = String(vars.prTitle || vars.caseId);
        const head = `Finds the ${goldens.length} known bug${goldens.length === 1 ? '' : 's'} in "`;
        const room = 160 - head.length - 1;
        entries.push({ id: vars.caseId, checks: `${head}${title.length > room ? `${title.slice(0, room - 1)}…` : title}"` });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { catalog };
