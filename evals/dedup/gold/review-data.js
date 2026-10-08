#!/usr/bin/env node
/**
 * Builds the human review page's data: per (model, PR), the suggestions, the
 * reconciled groups, what each judge said, and which decisions need review.
 *
 *   node evals/dedup/gold/review-data.js --scope=pilot --models=a,b --prs=a,b   (review everything)
 *   node evals/dedup/gold/review-data.js --scope=audit [--seed=1]               (all low + sampled mid/high)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const SCOPE = arg('scope', 'pilot');
const SEED = arg('seed', '1');
const models = (arg('models') || '').split(',').filter(Boolean);
const prs = (arg('prs') || '').split(',').filter(Boolean);
const rank = (s) => crypto.createHash('sha1').update(`${SEED}|${s}`).digest('hex');
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const repoOf = (c) => (c.endsWith('-cal-com') ? 'cal.com' : c.includes('discourse') ? 'discourse' : c.includes('grafana') ? 'grafana' : c.includes('keycloak') ? 'keycloak' : 'sentry');

const units = [];
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.json'))) {
    const gold = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    if (!gold.prs || (models.length && !models.includes(gold.model))) continue;
    for (const [caseId, pr] of Object.entries(gold.prs)) {
        if (prs.length && !prs.includes(caseId)) continue;
        if (!pr.groups.length && !Object.keys(pr.uniqueConfidence).length) continue;
        const judge = (j) => readJson(path.join(__dirname, 'runs', j, gold.model, `${caseId}.json`))?.answer || null;
        const pt = readJson(path.join(__dirname, 'review', 'translations', `${gold.model}__${caseId}.json`)) || {};
        const checks = readJson(path.join(__dirname, 'review', 'second-check', `${gold.model}__${caseId}.json`))?.checks || null;
        units.push({
            key: `${gold.model}__${caseId}`,
            model: gold.model,
            caseId,
            repo: repoOf(caseId),
            suggestions: pr.suggestions.map((s) => ({ id: s.id, by: s.producedBy, file: s.relevantFile, start: s.relevantLinesStart, end: s.relevantLinesEnd, summary: s.oneSentenceSummary || '', content: s.suggestionContent || '', ...(pt[s.id] || {}) })),
            groups: pr.groups.map((g) => ({ groupId: g.groupId, members: g.members, kind: g.kind, needsUnifiedComment: g.needsUnifiedComment, confidence: g.confidence, defect: g.defect, votes: g.votes, resolvedBy: g.resolvedBy, arbiterReasoning: g.arbiterReasoning || '' })),
            unique: Object.entries(pr.uniqueConfidence).map(([id, confidence]) => ({ id, confidence, ...(checks ? { secondCheck: checks[id] || [] } : {}) })),
            partialOverlap: pr.partialOverlap || [],
            judges: { opus: judge('opus'), astra: judge('astra') },
            review: [],
        });
    }
}

// Targets: a group (by groupId) or a unique suggestion (by id).
const targets = units.flatMap((u) => [
    ...u.groups.map((g) => ({ u, t: g.groupId, conf: g.confidence, kind: 'group' })),
    ...u.unique.map((x) => ({ u, t: x.id, conf: x.confidence, kind: 'unique' })),
]);
let picked;
if (SCOPE === 'pilot') picked = targets;
else {
    const low = targets.filter((x) => x.conf === 'low');
    const mid = targets.filter((x) => x.conf === 'mid');
    const midPick = [];
    for (const m of [...new Set(mid.map((x) => x.u.model))]) {
        const own = mid.filter((x) => x.u.model === m).sort((a, b) => rank(a.u.key + a.t).localeCompare(rank(b.u.key + b.t)));
        midPick.push(...own.slice(0, Math.ceil(own.length * 0.2)));
    }
    const highG = targets.filter((x) => x.conf === 'high' && x.kind === 'group').sort((a, b) => rank(a.u.key + a.t).localeCompare(rank(b.u.key + b.t))).slice(0, 30);
    const highU = targets.filter((x) => x.conf === 'high' && x.kind === 'unique').sort((a, b) => rank(a.u.key + a.t).localeCompare(rank(b.u.key + b.t))).slice(0, 30);
    picked = [...low.map((x) => ({ ...x, why: 'low' })), ...midPick.map((x) => ({ ...x, why: 'audit-mid' })), ...highG.map((x) => ({ ...x, why: 'audit-high' })), ...highU.map((x) => ({ ...x, why: 'audit-high' }))];
}
for (const p of picked) p.u.review.push({ target: p.t, kind: p.kind, why: p.why || 'pilot' });

// --prev=<earlier data file> --prev-decisions=<dir of saved decision docs>: mark what changed since that version.
const prevFile = arg('prev');
const migrate = [];
if (prevFile) {
    const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
    const decDir = arg('prev-decisions');
    const dec = (u, t) => {
        const f = decDir && path.join(decDir, `${u.model}__${u.caseId}__${t}.json`);
        if (!f || !fs.existsSync(f)) return null;
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        return d.data || d;
    };
    for (const u of units) {
        const pu = prev.units.find((x) => x.key === u.key);
        if (!pu) continue;
        const prevGroupOf = {};
        for (const g of pu.groups) for (const m of g.members) prevGroupOf[m] = g;
        const prevUnique = new Set(pu.unique.map((x) => x.id));
        const before = (ids) => {
            const seen = new Set();
            const out = [];
            for (const id of ids) {
                const g = prevGroupOf[id];
                if (g && !seen.has(g.groupId)) {
                    seen.add(g.groupId);
                    out.push({ kind: 'group', members: g.members, verdict: dec(pu, g.groupId)?.verdict || null });
                } else if (!g && prevUnique.has(id)) out.push({ kind: 'unique', members: [id], verdict: dec(pu, id)?.verdict || null });
            }
            return out;
        };
        for (const r of u.review) {
            if (r.kind === 'group') {
                const g = u.groups.find((x) => x.groupId === r.target);
                const same = pu.groups.find((x) => x.members.slice().sort().join('|') === g.members.slice().sort().join('|'));
                if (same) {
                    r.change = { status: 'same' };
                    const d = dec(pu, same.groupId);
                    if (d) migrate.push({ doc: `${u.model}__${u.caseId}__${g.groupId}`, data: { ...d, target: g.groupId } });
                } else r.change = { status: 'changed', before: before(g.members) };
            } else {
                r.change = prevUnique.has(r.target) ? { status: 'same' } : { status: 'changed', before: before([r.target]) };
            }
        }
    }
    const changed = units.flatMap((u) => u.review.filter((r) => r.change?.status === 'changed'));
    console.log(`vs ${path.basename(prevFile)}: ${changed.length} decisions changed, ${migrate.length} approvals carried to new group ids`);
    fs.writeFileSync(path.join(__dirname, 'review', `${SCOPE}-migrate.json`), JSON.stringify(migrate, null, 1));
}
const out = units.filter((u) => u.review.length);
const dir = path.join(__dirname, 'review');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${SCOPE}.json`);
fs.writeFileSync(file, JSON.stringify({ scope: SCOPE, generatedAt: new Date().toISOString(), units: out }));
console.log(`${SCOPE}: ${out.length} units, ${picked.length} decisions to review -> ${path.relative(process.cwd(), file)}`);
process.exit(0);
