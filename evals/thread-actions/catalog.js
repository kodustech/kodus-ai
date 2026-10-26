// The cases this eval runs (cases.js), each with what it checks: all of them,
// or one kind's (`--kind=rule` or `--kind=memory`), for the stage each kind
// measures (evals/stages.js names `evals/thread-actions/catalog.js#rule`). The
// offers stages (`--metric=offers`) run only the threads that do not ask Kody
// to act.
const { CASES, kindOf } = require('./cases');

function catalog(kind, offers = false) {
    return CASES.filter((c) => (!kind || kindOf(c) === kind) && (!offers || !c.expect.act)).map((c) => ({ id: c.id, checks: c.checks }));
}

const rule = { catalog: () => catalog('rule') };
const memory = { catalog: () => catalog('memory') };
const ruleOffers = { catalog: () => catalog('rule', true) };
const memoryOffers = { catalog: () => catalog('memory', true) };

module.exports = { catalog, rule, memory, ruleOffers, memoryOffers };
