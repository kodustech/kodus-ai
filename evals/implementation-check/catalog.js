// The cases this eval runs (cases.json, built by build-cases.js), each with what it checks.
const cases = require('./cases.json');

function catalog() {
    return cases.map((c) => ({ id: c.id, group: c.kind, checks: c.checks }));
}

module.exports = { catalog };
