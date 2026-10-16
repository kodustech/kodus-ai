// The cases of a stage eval over the frozen snapshot: one per nightly PR, with
// the known bugs the finder's candidates there match (snapshot/<model>.json).
const path = require('path');
const { knownBugs } = require('./known-bugs');

function catalogFor(stage, reaches = (c) => c.kept, snapshot = 'deepseek-v4-flash@fireworks') {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { cases } = require(path.join(__dirname, 'snapshot', `${snapshot}.json`));
    return cases.map((c) => {
        const reaching = new Set(c.candidates.filter(reaches).filter((x) => x.bug !== null).map((x) => x.bug)).size;
        return { id: c.caseId, checks: `Keeps the known bugs of ${c.caseId} that reach ${stage} (${reaching} of ${knownBugs(c.caseId).length})`.slice(0, 160) };
    });
}

module.exports = { catalogFor };
