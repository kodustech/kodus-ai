const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { SCORING_VERSION } = require('./scoring');

function runProvenance(datasetFiles) {
    const root = path.join(__dirname, '../..');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    return {
        measuredAt: new Date().toISOString(),
        engineCommit: git(['rev-parse', 'HEAD']),
        dirty: !!git(['status', '--porcelain', '--untracked-files=all', '--', 'libs', 'evals/security-scan']),
        datasets: Object.fromEntries(datasetFiles.map(file => [path.basename(file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
        scoringVersion: SCORING_VERSION,
    };
}
function scoringProvenance() {
    const hash = file => createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex');
    return {
        version: SCORING_VERSION,
        matcherSha256: hash('scoring.js'),
        adjudicationsSha256: hash('adjudications.json'),
    };
}
module.exports = { runProvenance, scoringProvenance };
