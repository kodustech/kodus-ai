const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

function runProvenance(datasetFiles) {
    const root = path.join(__dirname, '../..');
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    return {
        measuredAt: new Date().toISOString(),
        engineCommit: git(['rev-parse', 'HEAD']),
        dirty: !!git(['status', '--porcelain', '--untracked-files=all', '--', 'libs', 'evals/security-scan']),
        datasets: Object.fromEntries(datasetFiles.map(file => [path.basename(file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
        scoringVersion: 2,
    };
}
module.exports = { runProvenance };
