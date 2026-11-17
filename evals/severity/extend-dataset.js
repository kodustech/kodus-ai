#!/usr/bin/env node
/**
 * Grows the severity dataset (#1821) to 50 low, 70 medium and 50 high, with
 * real gold-v3 problems outside it, labelled from their text like the rest.
 *
 *   node evals/severity/extend-dataset.js draw   -> dataset/candidates.json
 *   node evals/severity/astra-label.js --items=candidates.json --out=astra-labels-candidates.json
 *   node evals/severity/extend-dataset.js pick   -> appends to dataset/items.json
 *
 * draw: a seeded sample per gold level, larger than the gap, since the level
 * the text supports often differs from the gold's. pick: per level still
 * short, the candidates Astra put at that level, in the draw's order.
 */
const fs = require('fs');
const path = require('path');
const { real, texts, shuffle, LABEL } = require('./build-dataset');

const DIR = path.join(__dirname, 'dataset');
const TARGET = { low: 50, medium: 70, high: 50 };
const DRAW = { low: 15, medium: 6, high: 15 };
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const dataset = read('items.json');
const have = new Set(dataset.items.map((x) => x.issueId));

if (process.argv[2] === 'draw') {
    const items = [];
    for (const [level, n] of Object.entries(DRAW)) {
        const pool = [...real.values()].filter((x) => x.severity === level && !have.has(x.issueId) && texts.has(x.issueId)).map((x) => x.issueId);
        for (const id of shuffle(pool, `extend|${level}`).slice(0, n)) {
            const g = real.get(id);
            const pick = shuffle(texts.get(id), id)[0];
            items.push({ issueId: id, caseId: g.caseId, severityGold: g.severity, classReviewed: g.class_reviewed, category: g.category || null, label: LABEL[g.category] || 'bug', source: pick.source, finding: { relevantFile: pick.relevantFile, relevantLinesStart: pick.relevantLinesStart, relevantLinesEnd: pick.relevantLinesEnd, suggestionContent: pick.suggestionContent } });
        }
    }
    fs.writeFileSync(path.join(DIR, 'candidates.json'), JSON.stringify({ items }, null, 1));
    console.log('candidates', items.length);
} else if (process.argv[2] === 'pick') {
    const labels = read('astra-labels-candidates.json');
    const count = (l) => dataset.items.filter((x) => x.severity === l).length;
    const added = [];
    for (const [level, n] of Object.entries(TARGET)) {
        const short = n - count(level);
        const fit = read('candidates.json').items.filter((x) => labels[x.issueId]?.severity === level);
        for (const x of fit.slice(0, Math.max(0, short))) added.push({ ...x, severity: level, labelBy: 'astra' });
        console.log(level, 'short', short, 'available', fit.length);
    }
    dataset.items.push(...added);
    fs.writeFileSync(path.join(DIR, 'items.json'), JSON.stringify(dataset, null, 1));
    const c = {};
    dataset.items.forEach((x) => (c[x.severity] = (c[x.severity] || 0) + 1));
    console.log('added', added.length, c);
} else {
    console.error('draw | pick');
    process.exit(2);
}
