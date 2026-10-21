#!/usr/bin/env node
/**
 * Severity dataset (#1821): gold-v3 problems the two classifiers (Opus, Astra)
 * agreed are real (`class` TP, whatever `class_reviewed` says), each with one
 * finder suggestion that reports it. Hallucinations and class-FP entries are
 * left out: their gold severity does not describe a real problem.
 *
 *   node evals/severity/build-dataset.js  ->  evals/severity/dataset/items.json
 *
 * Per level, seeded: 50 low, 50 medium, 50 high and every critical. The text
 * is the problem as a finder wrote it, preferring today's lean finder
 * (light + rescue runs), then the earlier rounds' suggestions.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const V3 = path.join(ROOT, 'evals/dedup/gold-v3');
const WORK = path.join(V3, 'trabalho');
const LR = path.join(WORK, 'light-rescue');
const OUT = path.join(__dirname, 'dataset');
const SEED = 'severity-v1';
const PER_LEVEL = { low: 50, medium: 50, high: 50, critical: Infinity };
// The finder labels a problem bug, security or performance; the gold's finer categories map onto those.
const LABEL = { security: 'security', perf: 'performance' };
const LEAN = ['sonnet', 'opus', 'ds', 'gpt', 'kimi', 'muse', 'ds20', 'kimi20'];

const rand = (s) => parseInt(crypto.createHash('sha256').update(`${SEED}|${s}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
const shuffle = (xs, s) => xs.map((x) => [rand(`${s}|${JSON.stringify(x)}`), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const flat = (f) => {
    const x = read(f);
    return Array.isArray(x) ? x : Object.values(x.prs).flat();
};

// The draw uses the level a problem had when the set was built, so a later
// relabel (severidadeAnterior) changes an item's gold, not which items are in.
const drawLevel = (x) => x.severidadeAnterior || x.severity;
const real = new Map(
    [...flat(`${V3}/golden.json`), ...flat(`${V3}/fps-conhecidos.json`)]
        .filter((x) => x.class === 'TP' && PER_LEVEL[drawLevel(x)])
        .map((x) => [x.issueId, x]),
);

// Every suggestion text that reports a real problem, by issue.
const texts = new Map();
const add = (issueId, source, file, lines, text) => {
    if (!real.has(issueId) || !text) return;
    (texts.get(issueId) || texts.set(issueId, []).get(issueId)).push({ source, relevantFile: file || '', relevantLinesStart: lines?.[0] ?? null, relevantLinesEnd: lines?.[1] ?? lines?.[0] ?? null, suggestionContent: text });
};
for (const k of LEAN) {
    const com = read(`${LR}/${k}/comentarios.json`);
    const match = {};
    for (const f of fs.readdirSync(`${LR}/${k}`).filter((f) => /^opus-out\d+\.json$/.test(f))) Object.assign(match, read(`${LR}/${k}/${f}`));
    for (const [c, items] of Object.entries(com)) {
        const m = Object.fromEntries((match[c] || []).map((x) => [x.id, x.match]));
        for (const it of items) add(m[it.id], `lean:${k}`, it.file, it.lines, it.texto);
    }
}
const lean = new Set(texts.keys());
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(WORK).filter((f) => /classif-in(-[ab])?\.json$/.test(f))) {
    for (const pr of Object.values(read(f))) {
        for (const iss of pr.issues || []) {
            if (lean.has(iss.issueId)) continue;
            for (const c of iss.comentarios || []) add(iss.issueId, `round:${path.relative(WORK, f)}:${c.gid}`, c.file, c.lines, c.texto);
        }
    }
}
const inv = read(`${WORK}/inventario.json`);
const groups = new Map();
for (const [c, v] of Object.entries(inv)) for (const g of v.grupos) for (const m of g.membros) groups.set(`${g.model}|${c}|${m}`, g);
for (const [key, issueId] of Object.entries(read(`${V3}/sugestoes.json`).sugestoes)) {
    const g = groups.get(key);
    if (g && !lean.has(issueId)) add(issueId, `inventory:${key}`, g.file, g.lines, g.texto);
}

// Sample per level; one suggestion per problem, drawn seeded.
const items = [];
const missing = {};
for (const [level, n] of Object.entries(PER_LEVEL)) {
    const pool = [...real.values()].filter((x) => drawLevel(x) === level);
    const covered = pool.filter((x) => texts.has(x.issueId));
    missing[level] = pool.length - covered.length;
    for (const x of shuffle(covered.map((x) => x.issueId), level).slice(0, n)) {
        const g = real.get(x);
        const pick = shuffle(texts.get(x), x)[0];
        items.push({ issueId: x, caseId: g.caseId, severity: g.severity, ...(g.severidadeAnterior && { severityBefore: g.severidadeAnterior }), classReviewed: g.class_reviewed, category: g.category || null, label: LABEL[g.category] || 'bug', source: pick.source, finding: { relevantFile: pick.relevantFile, relevantLinesStart: pick.relevantLinesStart, relevantLinesEnd: pick.relevantLinesEnd, suggestionContent: pick.suggestionContent } });
    }
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'items.json'), JSON.stringify({ seed: SEED, items }, null, 1));
const count = (k) => items.reduce((o, x) => ((o[x[k]] = (o[x[k]] || 0) + 1), o), {});
console.log('severity', count('severity'), 'class_reviewed', count('classReviewed'), 'without a suggestion text', missing);
