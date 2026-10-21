// The cases this eval runs (cases.js), each with what it checks: all of them,
// or one kind's (`--kind=rule` or `--kind=memory`), for the stage each kind
// measures (evals/stages.js names `evals/thread-actions/catalog.js#rule`).
const { CASES, kindOf } = require('./cases');

function catalog(kind) {
    return CASES.filter((c) => !kind || kindOf(c) === kind).map((c) => ({ id: c.id, checks: c.checks }));
}

const rule = { catalog: () => catalog('rule') };
const memory = { catalog: () => catalog('memory') };

module.exports = { catalog, rule, memory };
