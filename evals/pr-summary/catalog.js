// Cases: datasets/cases.json (run.js's default --dataset), plus the routing guard and commit-run gate scenarios run.js checks first, read from its source because requiring run.js runs the eval.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cases = require('./datasets/cases.json');

const MAX = 160;
const START = 'kody-pr-summary:start';
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    const verb = e.postsSummary ? 'Posts' : 'Writes';
    const head = `${verb} ${e.exactlyOneBlock ? 'exactly one' : 'a'} summary block ${when} under ${String(c.behaviour).toUpperCase()}`;
    return clip(`${head}${clauses.length ? `, ${and(clauses)}` : ''}.`);
}

// run.js's own definitions, read as text: the commit-gate scenarios array and the routing default.
function runSource() {
    const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    const at = src.indexOf('const scenarios = [');
    const end = src.indexOf('\n    ];', at);
    const fallback = src.match(/const SUMMARY_DEFAULT = '([^']+)'/);
    if (at < 0 || end < 0 || !fallback) throw new Error('pr-summary/catalog.js: run.js no longer defines `const scenarios = [` / SUMMARY_DEFAULT; update the catalog');
    const scenarios = vm.runInNewContext(`(${src.slice(at + 'const scenarios = '.length, end + '\n    ]'.length)})`, {});
    return { scenarios, summaryDefault: fallback[1] };
}

function scenarioChecks(s) {
    const event = s.last ? 'on a new commit' : 'when the PR opens';
    const config = s.summary.generatePRSummary === false
        ? ' with the summary turned off'
        : s.summary.behaviourForNewCommits
          ? ` under new-commit behaviour ${s.summary.behaviourForNewCommits.toUpperCase()}`
          : '';
    const outcome = s.call ? 'Generates and posts the summary' : 'Neither generates nor posts the summary';
    const flag = s.call && s.commit !== undefined ? `, ${s.commit ? '' : 'not '}flagged as a commit run` : '';
    return clip(`${outcome} ${event}${config}, decided at the pipeline stage${flag}.`);
}

function catalog() {
    const { scenarios, summaryDefault } = runSource();
    return [
        {
            id: 'routing-guard',
            checks: clip(`Routes the summary to ${summaryDefault} when no model is configured, and on live runs to exactly the configured model, never a silent swap.`),
        },
        ...scenarios.map((s) => ({ id: `commit-gate-${slug(s.name)}`, checks: scenarioChecks(s) })),
        ...cases.map((c) => ({ id: c.caseId, checks: caseChecks(c) })),
    ];
}

module.exports = { catalog };
