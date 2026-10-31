// The cases this eval runs: one per finding of the enrichment dataset
// (evals/enrichment/dataset/items.json), each with what it checks. A finding
// whose fix fits exactly its cited lines must get one; the others must get no code.
const { items } = require('../enrichment/dataset/items.json');
const { mustFix, loadReferences } = require('./judge');

function casesOf() {
    const refs = loadReferences();
    return items.map((item) => {
        const ref = refs.get(item.issueId);
        if (!ref) throw new Error(`no reference for ${item.issueId}`);
        const fix = mustFix(item, ref);
        return {
            id: item.issueId,
            item,
            ref,
            mustFix: fix,
            checks: fix
                ? 'Writes a fix for the cited lines that the judge passes, under a title that names the problem'
                : `Writes no code (no fix fits the cited lines: ${ref.fixability}), under a title that names the problem`,
        };
    });
}

// The panel lists the cases by repository and by what they must get.
function catalog() {
    const groups = new Map();
    for (const c of casesOf()) {
        const key = `${c.item.repo}:${c.mustFix ? 'fix' : 'no-code'}`;
        if (!groups.has(key)) groups.set(key, { repo: c.item.repo, mustFix: c.mustFix, n: 0 });
        groups.get(key).n++;
    }
    return [...groups].map(([id, g]) => ({
        id,
        checks: g.mustFix
            ? `Writes a fix the judge passes for each of ${g.n} ${g.repo} findings whose fix fits the cited lines, under a title that names the problem`
            : `Writes no code for each of ${g.n} ${g.repo} findings no fix fits, under a title that names the problem`,
    }));
}

module.exports = { catalog, casesOf };
