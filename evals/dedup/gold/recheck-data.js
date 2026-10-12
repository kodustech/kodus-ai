#!/usr/bin/env node
/**
 * Builds the recheck review page data: only the groups where Opus or Astra
 * (recheck-groups.js) proposes a split under the main-defect rule.
 *
 *   node evals/dedup/gold/recheck-data.js
 */
const fs = require('fs');
const path = require('path');

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const repoOf = (c) => (c.endsWith('-cal-com') ? 'cal.com' : c.includes('discourse') ? 'discourse' : c.includes('grafana') ? 'grafana' : c.includes('keycloak') ? 'keycloak' : 'sentry');
const OUT_DIR = path.join(__dirname, 'review', 'recheck');

const units = [];
let groups = 0;
let missing = 0;
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.json') && x !== 'human-overrides.json')) {
    const gold = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    if (!gold.prs) continue;
    for (const [caseId, pr] of Object.entries(gold.prs)) {
        const pt = readJson(path.join(__dirname, 'review', 'translations', `${gold.model}__${caseId}.json`)) || {};
        const items = [];
        for (const g of pr.groups) {
            if (g.members.length < 2) continue;
            groups++;
            const base = path.join(__dirname, 'runs', 'recheck', gold.model, `${caseId}__${g.groupId}`);
            const opus = readJson(`${base}.opus.json`)?.answer;
            const astra = readJson(`${base}.astra.json`)?.answer;
            if (!opus || !astra) {
                missing++;
                continue;
            }
            const so = opus.verdict === 'split';
            const sa = astra.verdict === 'split';
            if (!so && !sa) continue;
            const norm = (a) => JSON.stringify([...a.groups.map((x) => [...x.members].sort().join('|')), ...a.unique.map((u) => u)].sort());
            items.push({
                groupId: g.groupId,
                defect: g.defect,
                kind: g.kind,
                resolvedBy: g.resolvedBy,
                approvedBefore: !!g.humanReview,
                members: g.members,
                who: so && sa ? 'both' : so ? 'opus' : 'astra',
                sameProposal: so && sa && norm(opus) === norm(astra),
                opus,
                astra,
            });
        }
        if (!items.length) continue;
        const ids = new Set(items.flatMap((i) => i.members));
        units.push({
            key: `${gold.model}__${caseId}`,
            model: gold.model,
            caseId,
            repo: repoOf(caseId),
            labels: Object.fromEntries(pr.suggestions.map((s, n) => [s.id, `S${n + 1}`])),
            suggestions: pr.suggestions.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, by: s.producedBy, file: s.relevantFile, start: s.relevantLinesStart, end: s.relevantLinesEnd, summary: s.oneSentenceSummary || '', content: s.suggestionContent || '', ...(pt[s.id] || {}) })),
            items,
            unique: [],
        });
    }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'recheck.json'), JSON.stringify({ generatedAt: new Date().toISOString(), units }));
const n = units.reduce((a, u) => a + u.items.length, 0);
const both = units.reduce((a, u) => a + u.items.filter((i) => i.who === 'both').length, 0);
console.log(`recheck: ${groups} groups checked, ${missing} missing answers, ${n} with a split proposal (${both} by both) in ${units.length} PRs`);
process.exit(missing ? 2 : 0);
