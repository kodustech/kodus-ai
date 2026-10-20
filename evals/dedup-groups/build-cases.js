#!/usr/bin/env node
// Builds cases/<pool>.json from the dedup gold v2 of #1821 (Junior's labels on
// feat/improve-harness-to-big-models, evals/dedup/gold-v2): for each of the
// 30 PRs, the suggestions one finder pool produced (<date>_<pool>.json) and
// the duplicate groups the labels settled on (<date>_<pool>.final.json, the
// coverage rule of 2026-10-10). Run once per relabel; the cases record where
// they came from.
//
//   node evals/dedup-groups/build-cases.js [--ref=origin/feat/improve-harness-to-big-models]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const POOLS = ['deepseek-v4.1-flash', 'gpt-6.1-sol', 'sonnet-5.5', 'muse-spark-1.2'];
const DATE = '09.10.26';
const ref = (process.argv.find((a) => a.startsWith('--ref=')) || '--ref=origin/feat/improve-harness-to-big-models').slice('--ref='.length);
const git = (...args) => execFileSync('git', args, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commit = git('rev-parse', ref).trim();
const show = (file) => JSON.parse(git('show', `${commit}:evals/dedup/gold-v2/${file}`));

for (const pool of POOLS) {
    const inputs = show(`${DATE}_${pool}.json`);
    const final = show(`${DATE}_${pool}.final.json`);
    const cases = Object.keys(inputs.prs).map((pr) => {
        const suggestions = inputs.prs[pr].suggestions.map((s) => ({
            id: s.id,
            label: s.label,
            relevantFile: s.relevantFile,
            relevantLinesStart: s.relevantLinesStart,
            relevantLinesEnd: s.relevantLinesEnd,
            suggestionContent: s.suggestionContent,
        }));
        // Every suggestion has an entry: a grouped one names its group's members,
        // a suggestion alone in its group names none.
        const byKey = new Map();
        for (const [id, g] of Object.entries(final.prs[pr] || {})) {
            const members = [...new Set(g.membros || [id])].sort();
            byKey.set(members.join(','), members);
        }
        const groups = [...byKey.values()];
        const ids = new Set(suggestions.map((s) => s.id));
        const grouped = groups.flat();
        if (grouped.length !== ids.size || grouped.some((id) => !ids.has(id))) throw new Error(`${pool}/${pr}: the final groups do not cover each suggestion exactly once`);
        return { id: `${pool}/${pr}`, pr, suggestions, groups };
    });
    const out = { pool, source: { ref, commit, inputs: `evals/dedup/gold-v2/${DATE}_${pool}.json`, groups: `evals/dedup/gold-v2/${DATE}_${pool}.final.json`, rule: final.regra || null }, cases };
    fs.writeFileSync(path.join(__dirname, 'cases', `${pool}.json`), `${JSON.stringify(out, null, 1)}\n`);
    const pairs = cases.reduce((n, c) => n + c.groups.reduce((m, g) => m + (g.length * (g.length - 1)) / 2, 0), 0);
    console.log(`${pool}: ${cases.length} PRs, ${cases.reduce((n, c) => n + c.suggestions.length, 0)} suggestions, ${cases.reduce((n, c) => n + c.groups.length, 0)} groups, ${pairs} duplicate pairs`);
}
