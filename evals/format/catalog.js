// The cases this eval runs (cases.json), one entry per production
// configuration: every recorded review's findings formatted under it.
const cases = require('./cases.json');
const batches = require('./batches.json');
const { VARIANTS } = require('./variants');

function catalog() {
    const findings = batches.reduce((n, b) => n + b.findings.length, 0);
    return Object.entries(VARIANTS).map(([id, v]) => {
        const count = cases.filter((c) => c.variant === id).length;
        const checks = `Formats ${findings} real findings from ${count} reviews ${v.checks}: no WHAT/WHY/HOW, code names kept, language and length right`;
        return { id, group: 'configuration', count, checks: checks.length > 160 ? `${checks.slice(0, 159)}…` : checks };
    });
}

module.exports = { catalog };
