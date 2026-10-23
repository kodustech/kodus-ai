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
                ? `Writes a fix for the cited lines of ${item.finding.relevantFile} that the judge passes, under a title that names the problem`
                : `Writes no code for ${item.finding.relevantFile} (no correct fix fits the cited lines: ${ref.fixability}), under a title that names the problem`,
        };
    });
}

function catalog() {
    return casesOf().map((c) => ({ id: c.id, checks: c.checks }));
}

module.exports = { catalog, casesOf };
