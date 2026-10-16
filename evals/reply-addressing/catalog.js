// Cases: cases.json (run.js's default --dataset; the wiring smoke runs its first two) and repo-cases.json (on demand, --dataset=repo-cases), one entry per category and expected answer.
const DATASETS = [
    { name: 'cases', cases: require('./cases.json') },
    { name: 'repo-cases', cases: require('./repo-cases.json'), onDemand: true },
];

const MAX = 160;
const words = (s) => String(s).replace(/[_-]+/g, ' ');
// As run.js counts it: more than one human (not Kody, not a bot) in the thread.
const isMultiHuman = (c) => new Set(c.messages.filter((m) => m.author !== 'Kody' && !m.bot).map((m) => m.author)).size > 1;
const repoOf = (c) => (String(c.source || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/) || [])[1];

function checks(dataset, category, expected, cs) {
    const n = cs.length;
    const head = expected === 'respond'
        ? `Answers ${n} ${n === 1 ? 'reply' : 'replies'} meant for Kody`
        : `Stays silent on ${n} ${n === 1 ? 'reply' : 'replies'} not meant for Kody`;
    const multi = cs.filter(isMultiHuman).length;
    const talk = multi ? `, ${multi === n ? 'all' : multi} in threads where two people talk` : '';
    if (dataset.onDemand) {
        const repos = [...new Set(cs.map(repoOf).filter(Boolean))];
        const prs = new Set(cs.map((c) => c.source).filter(Boolean)).size;
        const where = repos.length ? ` in real Kody threads on ${repos.join(', ')} (${prs} PRs)` : ` (category ${words(category)})`;
        const run = `; on demand (--dataset=${dataset.name})`;
        return [`${head}${where}${talk}${run}.`, `${head}${where}${run}.`, `${head}${where}.`].find((t) => t.length <= MAX) || `${head}.`;
    }
    const text = `${head} (category ${words(category)})${talk}`;
    // Examples from the case ids, as many as fit.
    const examples = [];
    for (const c of cs) {
        const next = `${text}, such as ${[...examples, words(c.id)].join(', ')}.`;
        if (next.length > MAX) break;
        examples.push(words(c.id));
    }
    return examples.length ? `${text}, such as ${examples.join(', ')}.` : `${text}.`;
}

function catalog() {
    const entries = [];
    for (const dataset of DATASETS) {
        const groups = new Map();
        for (const c of dataset.cases) {
            const key = `${c.category}-${c.expected}`;
            if (!groups.has(key)) groups.set(key, { category: c.category, expected: c.expected, cases: [] });
            groups.get(key).cases.push(c);
        }
        for (const [key, g] of groups) {
            entries.push({
                id: dataset.name === 'cases' ? key : `${dataset.name}:${key}`,
                group: `${dataset.name}/${g.category}`,
                count: g.cases.length,
                checks: checks(dataset, g.category, g.expected, g.cases),
            });
        }
    }
    return entries;
}

module.exports = { catalog };
