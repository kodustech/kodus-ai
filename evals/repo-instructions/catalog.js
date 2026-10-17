// The cases buildCases() makes from github-cases.json: one convention, stated
// in a CLAUDE.md beside a decoy instruction, on one real PR that breaks it.
const { buildCases } = require('./cases');

function catalog() {
    return buildCases().map((c) => {
        const sites = Object.values(c.groundTruth || {}).reduce((n, hits) => n + hits.length, 0);
        const where = c.caseId.replace(/^repo-instructions:/, '').split('::')[0];
        const checks = `Reports all ${sites} line${sites === 1 ? '' : 's'} in ${where} breaking a CLAUDE.md convention, quoting it, never the decoy: "${c.convention}"`;
        return { id: c.caseId, checks: checks.length > 160 ? `${checks.slice(0, 159)}…` : checks };
    });
}

module.exports = { catalog };
