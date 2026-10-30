// The cases this eval runs (cases.js), each with what it checks.
const { CASES } = require('./cases');

function catalog() {
    return CASES.map((c) => ({ id: c.id, checks: c.checks }));
}

module.exports = { catalog };
