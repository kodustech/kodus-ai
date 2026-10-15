// The cases of github-cases.json (the set the nightly runs): one rule on one
// real PR, with every line that breaks it enumerated.
const cases = require('./github-cases.json');

function catalog() {
    return cases.map((c) => {
        const sites = Object.values(c.groundTruth || {}).reduce((n, hits) => n + hits.length, 0);
        const where = String(c.caseId || '').split('::')[0];
        const checks = `Flags all ${sites} line${sites === 1 ? '' : 's'} breaking "${c.rule?.title || c.rule?.uuid}" in ${where}`;
        return { id: c.caseId, checks: checks.length > 160 ? `${checks.slice(0, 159)}…` : checks };
    });
}

module.exports = { catalog };
