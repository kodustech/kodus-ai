// The cases this eval runs (cases.json), each with what it checks.
const cases = require('./cases.json');

function catalog() {
    return cases.map((c) => ({ id: c.id, checks: c.checks }));
}

module.exports = { catalog };
