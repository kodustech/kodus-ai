// The cases this eval runs (cases.json): one PR each, with the ticket it closes.
const cases = require('./cases.json');

function catalog() {
    return cases.map((c) => ({ id: c.id, checks: c.checks }));
}

module.exports = { catalog };
