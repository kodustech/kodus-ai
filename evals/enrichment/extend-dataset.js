#!/usr/bin/env node
/**
 * Candidates to grow the enrichment dataset (#1821): every gold-v3 TP outside
 * dataset/items.json that some judged finder suggestion reports with a file
 * and lines inside the PR. Same frozen input as build-dataset.js; Astra then
 * classifies them (astra-references.js --items=candidates.json) and
 * pick-extension.js draws the items that complete each group.
 *
 *   node evals/enrichment/extend-dataset.js  ->  evals/enrichment/dataset/candidates.json
 *
 * Text sources, in order: today's lean finder (light + rescue runs), then the
 * earlier rounds' classification inputs, then the inventory. One suggestion
 * per TP, drawn seeded among the anchored ones of the first source that has any.
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { enrichDeterministic } = require('../../libs/code-review/infrastructure/agents/engine/enrich-deterministic');

const ROOT = path.join(__dirname, '..', '..');
const V3 = path.join(ROOT, 'evals/dedup/gold-v3');
const WORK = path.join(V3, 'trabalho');
const LR = path.join(WORK, 'light-rescue');
const OUT = path.join(__dirname, 'dataset');
const SEED = 'enrichment-v2';
const TEST_SHARE = 0.4;
const WINDOW = 60;
const LEAN = ['sonnet', 'opus', 'ds', 'gpt', 'kimi', 'muse', 'ds20', 'kimi20'];
const LABEL = { security: 'security', perf: 'performance' };
const rand = (s) => parseInt(crypto.createHash('sha256').update(`${SEED}|${s}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const current = read(path.join(OUT, 'items.json')).items;
const inDataset = new Set(current.map((x) => x.issueId));
const splitOfPr = new Map(current.map((x) => [x.caseId, x.split]));
const tps = Object.values(read(`${V3}/golden.json`).prs).flat().filter((r) => r.class_reviewed === 'TP' && !inDataset.has(r.issueId));
const tpById = new Map(tps.map((t) => [t.issueId, t]));
const repos = read(`${WORK}/repos.json`);
const repoOf = (c) => path.basename(repos[c].repo);

const patches = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'evals/investigation/datasets')).filter((f) => f.endsWith('.json'))) {
    for (const row of [].concat(read(path.join(ROOT, 'evals/investigation/datasets', f)))) {
        const v = row && row.vars;
        if (v && v.caseId && Array.isArray(v.prFiles)) patches.set(v.caseId, new Map(v.prFiles.map((p) => [p.filename, p.patch || ''])));
    }
}
const anchored = (c, f) => f.relevantFile && f.relevantLinesStart != null && f.relevantLinesEnd != null && patches.get(c)?.has(f.relevantFile);

// Suggestions per TP and source rank (0 lean, 1 rounds, 2 inventory).
const texts = new Map();
const add = (issueId, rank, source, label, file, lines, text) => {
    const t = tpById.get(issueId);
    if (!t || !text) return;
    const finding = { label: label || LABEL[t.category] || 'bug', relevantFile: file || '', relevantLinesStart: lines?.[0] ?? null, relevantLinesEnd: lines?.[1] ?? lines?.[0] ?? null, suggestionContent: text };
    if (!anchored(t.caseId, finding)) return;
    (texts.get(issueId) || texts.set(issueId, []).get(issueId)).push({ rank, source, finding });
};
for (const k of LEAN) {
    const com = read(`${LR}/${k}/comentarios.json`);
    const match = {};
    for (const f of fs.readdirSync(`${LR}/${k}`).filter((f) => /^opus-out\d+\.json$/.test(f))) Object.assign(match, read(`${LR}/${k}/${f}`));
    for (const [c, items] of Object.entries(com)) {
        const m = Object.fromEntries((match[c] || []).map((x) => [x.id, x.match]));
        for (const it of items) add(m[it.id], 0, `lean:${k}:${c}:${it.id}`, it.label, it.file, it.lines, it.texto);
    }
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk(WORK).filter((f) => /classif-in(-[ab])?\.json$/.test(f))) {
    for (const pr of Object.values(read(f))) {
        for (const iss of pr.issues || []) for (const c of iss.comentarios || []) add(iss.issueId, 1, `round:${path.relative(WORK, f)}:${c.gid}`, null, c.file, c.lines, c.texto);
    }
}
const groups = new Map();
for (const [c, v] of Object.entries(read(`${WORK}/inventario.json`))) for (const g of v.grupos) for (const m of g.membros) groups.set(`${g.model}|${c}|${m}`, g);
for (const [key, issueId] of Object.entries(read(`${V3}/sugestoes.json`).sugestoes)) {
    const g = groups.get(key);
    if (g) add(issueId, 2, `inventory:${key}`, null, g.file, g.lines, g.texto);
}

const headFile = (c, file) => {
    try {
        return execFileSync('git', ['-C', repos[c].repo, 'show', `${repos[c].head}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
};
const numbered = (content, from, to) => content.split('\n').slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)} | ${l}`).join('\n');

const items = [...texts.keys()].sort().map((id) => {
    const t = tpById.get(id);
    const list = texts.get(id);
    const best = Math.min(...list.map((x) => x.rank));
    const top = list.filter((x) => x.rank === best).sort((a, b) => (a.source < b.source ? -1 : 1));
    const pick = top[Math.floor(rand(id) * top.length)];
    const f = pick.finding;
    const content = headFile(t.caseId, f.relevantFile);
    const total = content == null ? 0 : content.split('\n').length;
    const from = Math.max(1, f.relevantLinesStart - WINDOW);
    const to = Math.min(total, f.relevantLinesEnd + WINDOW);
    return {
        issueId: id,
        caseId: t.caseId,
        repo: repoOf(t.caseId),
        headSha: repos[t.caseId].head,
        split: splitOfPr.get(t.caseId) || (rand(`split|${t.caseId}`) < TEST_SHARE ? 'test' : 'dev'),
        gold: { comment: t.commentOpus || t.comment, severity: t.severity, category: t.category },
        provenance: { source: pick.source, candidates: list.length },
        finding: f,
        deterministic: enrichDeterministic(f, content),
        rangeSize: f.relevantLinesEnd - f.relevantLinesStart + 1,
        context: {
            window: content == null ? '' : numbered(content, from, to),
            windowLines: [from, to],
            filePatch: patches.get(t.caseId)?.get(f.relevantFile) ?? '',
        },
    };
});

const body = JSON.stringify({ version: SEED, items }, null, 1);
fs.writeFileSync(path.join(OUT, 'candidates.json'), body);
const count = (fn) => items.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});
console.log({
    outside: tps.length,
    candidates: items.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    source: count((x) => x.provenance.source.split(':')[0]),
    anchor: count((x) => x.deterministic.anchorStatus),
    split: count((x) => x.split),
    repo: count((x) => x.repo),
});
process.exit(0);
