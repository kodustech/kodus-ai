// Which datasets anchor-eval.js runs: the investigation datasets, sorted by
// name so every machine takes the same --limit prefix. Shared with catalog.js,
// so what the panel lists is what a run covers.
const fs = require('fs');
const path = require('path');

const DATASETS_DIR = path.join(__dirname, '../investigation/datasets');
const DEFAULT_LIMIT = 8;

function datasetFiles(limit) {
    const all = fs.readdirSync(DATASETS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
    return limit === undefined ? all : all.slice(0, limit);
}

module.exports = { DATASETS_DIR, DEFAULT_LIMIT, datasetFiles };
