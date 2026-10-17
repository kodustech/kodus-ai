// The known bugs of each nightly PR, read from one place: the stage evals over
// the frozen snapshot (evals/funnel) take them from here only, so the relabeled
// dataset (#2114, its design's open item) is a change to this file's source.
// Today: the `goldenComments` of evals/investigation/datasets/<case>.json.
const fs = require('fs');
const path = require('path');

const SOURCE = 'evals/investigation/datasets/<case>.json goldenComments';
const DATASETS = path.join(__dirname, '..', 'investigation', 'datasets');

// A case's dataset vars. Most files are named after their case; a few are not,
// so the rest are indexed by the caseId they hold.
let index = null;
function datasetFor(caseId) {
    const read = (file) => {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const raw = require(path.join(DATASETS, file));
        return (Array.isArray(raw) ? raw[0] : raw).vars;
    };
    if (fs.existsSync(path.join(DATASETS, `${caseId}.json`))) return read(`${caseId}.json`);
    if (!index) {
        index = new Map();
        for (const file of fs.readdirSync(DATASETS).filter((f) => f.endsWith('.json'))) {
            try {
                const vars = read(file);
                if (vars?.caseId) index.set(vars.caseId, file);
            } catch {
                /* not a case dataset */
            }
        }
    }
    if (!index.has(caseId)) throw new Error(`no dataset holds case ${caseId}`);
    return read(index.get(caseId));
}

function knownBugs(caseId) {
    const vars = datasetFor(caseId);
    const goldens = typeof vars.goldenComments === 'string' ? JSON.parse(vars.goldenComments) : vars.goldenComments || [];
    return goldens.map((g, i) => ({
        index: i,
        text: typeof g === 'string' ? g : String(g.comment || ''),
        severity: typeof g === 'object' && g.severity ? String(g.severity).toLowerCase() : null,
    }));
}

module.exports = { knownBugs, datasetFor, SOURCE };
