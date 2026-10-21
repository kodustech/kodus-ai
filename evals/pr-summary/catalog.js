// Cases: datasets/cases.json (run.js's default --dataset).
const cases = require('./datasets/cases.json');

const MAX = 160;
const START = 'kody-pr-summary:start';
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const clip = (s) => (s.length <= MAX ? s : `${s.slice(0, MAX - 1)}…`);

// One dataset case: the event, the configured behaviour, and what runCase asserts.
function caseChecks(c) {
    const e = c.expect || {};
    const body = c.existingBody || '';
    // The author's text as run.js finds it: the first line outside the Kody block markers.
    const author = body.split('\n').find((l) => l.trim() && !l.includes('kody-pr-summary'));
    const prior = body.includes(START);
    const when = c.mode === 'commit' ? 'on a new commit' : prior ? 'on a re-run of the first summary' : 'when the PR opens';
    const clauses = [];
    if (!body) clauses.push('with no description yet');
    if (c.mode === 'commit' && !prior) clauses.push('with no earlier Kody summary');
    if (author && e.bodyPreserved === true) clauses.push("keeping the author's text");
    if (author && e.bodyPreserved === false) clauses.push("dropping the author's text");
    if (e.promptContainsExistingBody) clauses.push(author && e.bodyPreserved !== undefined ? 'passing it to the model' : "passing the author's text to the model");
    if (e.staleContentGone) clauses.push('removing the earlier Kody summary');
    if (e.blockAccumulates) clauses.push('adding to the earlier summary inside the block');
    if (e.generates === false) {
        const config = c.generatePRSummary === false ? ' with the summary turned off' : ` under new-commit behaviour ${String(c.behaviour).toUpperCase()}`;
        return clip(`Neither generates nor posts a summary ${when}${config}.`);
    }
    if (c.storedConfig) {
        const to = c.storedConfig.routing?.taskOverrides?.prSummary;
        return clip(`Sends the summary to the model the org's BYOK config routes prSummary to (${to}), not its default model, and posts it ${when}.`);
    }
    const findings = (c.review?.lineComments || []).length + (c.review?.prLevelComments || []).length;
    if (findings) clauses.push(`with the review's ${findings} finding${findings === 1 ? '' : 's'} in the prompt`);
    const verb = e.postsSummary ? 'Posts' : 'Writes';
    const head = `${verb} ${e.exactlyOneBlock ? 'exactly one' : 'a'} summary block ${when} under ${String(c.behaviour).toUpperCase()}`;
    return clip(`${head}${clauses.length ? `, ${and(clauses)}` : ''}.`);
}

function catalog() {
    return cases.map((c) => ({ id: c.caseId, checks: caseChecks(c) }));
}

module.exports = { catalog };
