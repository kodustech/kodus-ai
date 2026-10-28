// The cases this eval runs: one per PR of the severity dataset
// (evals/severity/dataset/items.json), its suggestions in one call, each with what it checks.
const { items } = require('../severity/dataset/items.json');

const LEVELS = ['low', 'medium', 'high', 'critical'];

function casesOf() {
    const byPr = new Map();
    for (const item of items) {
        if (!byPr.has(item.caseId)) byPr.set(item.caseId, []);
        byPr.get(item.caseId).push(item);
    }
    return [...byPr].map(([id, prItems]) => {
        const counts = LEVELS.map((l) => [l, prItems.filter((x) => x.severity === l).length]).filter(([, n]) => n);
        return {
            id,
            items: prItems,
            checks: `Rates the ${prItems.length} suggestion${prItems.length === 1 ? '' : 's'} of ${id} at their defined level (${counts.map(([l, n]) => `${n} ${l}`).join(', ')})`,
        };
    });
}

// One entry per defined level (the panel lists at most 60): the 75 PRs are the
// calls, the 205 suggestions what each call rates.
function catalog() {
    return LEVELS.map((level) => {
        const count = items.filter((x) => x.severity === level).length;
        return { id: level, group: 'defined level', count, checks: `Rates each of the ${count} suggestions whose text defines ${level} as ${level}, in the call of its PR` };
    });
}

module.exports = { catalog, casesOf, LEVELS };
