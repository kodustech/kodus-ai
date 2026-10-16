// Cases: the PRs of evals/kody-rules/polyglot-cases.json, a Ruby-only rule over
// real polyglot PRs, run by evals/kody-rules/real-agent.js --dataset=polyglot-cases.
const cases = require('../kody-rules/polyglot-cases.json');

const MAX = 160;
const clip = (s) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

function catalog() {
    return cases.map((c) => {
        const where = String(c.caseId).split('::')[0];
        const lang = c.rule.language;
        return { id: c.caseId, checks: clip(`Keeps the ${lang}-only rule "${c.rule.title}" from commenting on its ${c.cleanFiles.length} non-${lang} files in ${where}`) };
    });
}

module.exports = { catalog };
