// The cases of a stage eval over the frozen snapshot: one per PR of the set where a
// known bug reaches the stage, with the known bugs the findings it got there
// match (snapshot/<model>.json), then the stage's control pair (controls.js). A
// PR where none reaches has nothing to keep.
const path = require('path');
const { knownBugs, datasetFor } = require('./known-bugs');

// A case's sentence, named by its PR's title like the finder's, within the
// panel's 160 characters (evals/shared/eval-result.js).
function caseSentence(caseId, stage, reaching, known) {
    const title = String(datasetFor(caseId).prTitle || caseId);
    const rest = `" that reach ${stage}: ${reaching} of its ${known}`;
    const room = 160 - 'Keeps the known bugs of "'.length - rest.length;
    return `Keeps the known bugs of "${title.length > room ? `${title.slice(0, room - 1)}…` : title}${rest}`;
}

// The findings a stage gets in a snapshot case (verify: every loop's; anchoring: every agent's).
const inputOf = (stage, c) =>
    stage === 'verify' ? c.verify.loops.flatMap((l) => l.candidates) : stage === 'anchoring' ? c.anchoring.agents.flatMap((a) => a.candidates) : c[stage].candidates;

// The controlled set by default: what the nightly and every model's weekly run
// measure (stage-run.js --set).
function catalogFor(stage, snapshot = 'deepseek-v4-flash@fireworks', set = 'controlled') {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { cases } = require(path.join(__dirname, 'snapshot', `${snapshot}.json`));
    const { CONTROLS } = require('./controls');
    const { CASE_SETS } = require('../investigation/recall-tests');
    return [
        ...cases
            .filter((c) => set === 'full' || CASE_SETS.controlled.includes(c.caseId))
            .map((c) => ({ c, reaching: new Set(inputOf(stage, c).filter((x) => x.bug !== null).map((x) => x.bug)).size }))
            .filter(({ reaching }) => reaching > 0)
            .map(({ c, reaching }) => ({ id: c.caseId, checks: caseSentence(c.caseId, stage, reaching, knownBugs(c.caseId).length) })),
        ...(CONTROLS[stage] || []).map((control) => ({ id: control.id, checks: control.checks })),
    ];
}

module.exports = { catalogFor, caseSentence };
