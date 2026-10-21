#!/usr/bin/env node
/**
 * Enrichment dataset (#1821): 100 gold-v3 TPs as the same fixed input for
 * every model. Each item is one lean finding taken from today's light + rescue
 * runs (the finder's current output), chosen model-blind by a seeded draw
 * among the findings the Opus judge matched to that TP.
 *
 *   node evals/enrichment/build-dataset.js  ->  evals/enrichment/dataset/items.json
 *
 * Sampling: 100 of the TPs those runs cover, allocated by repo x severity
 * (largest remainder), seeded. Split by PR, ~40 items to test, per repo.
 * existingCode and language come from production's enrichDeterministic.
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
const LR = path.join(V3, 'trabalho/light-rescue');
const POOLS = path.join(ROOT, 'evals/investigation/pools');
const OUT = path.join(__dirname, 'dataset');
const SEED = 'enrichment-v1';
const N = 100;
const TEST_SHARE = 0.4;
const WINDOW = 60; // lines of context on each side of the cited range
const KEYS = ['sonnet', 'opus', 'ds', 'gpt', 'kimi', 'muse', 'ds20', 'kimi20'];

const rand = (s) => parseInt(crypto.createHash('sha256').update(`${SEED}|${s}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
const shuffle = (xs, s) => xs.map((x, i) => [rand(`${s}|${i}|${JSON.stringify(x)}`), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const tps = Object.values(read(`${V3}/golden.json`).prs).flat().filter((r) => r.class_reviewed === 'TP');
const tpById = new Map(tps.map((t) => [t.issueId, t]));
const repos = read(`${V3}/trabalho/repos.json`);

// Every lean finding the Opus judge matched to a TP, with its label from the pool.
const pool = new Map();
const poolCase = (k, c) => {
    const key = `${k}|${c}`;
    if (!pool.has(key)) {
        const f = ['light', 'holdout'].map((s) => path.join(POOLS, `20.10.26_lightrescue_${k}-${s}`, `${c}.raw.txt`)).find(fs.existsSync);
        pool.set(key, f ? read(f).trace.preFilterCandidates || [] : []);
    }
    return pool.get(key);
};
const cands = new Map();
for (const k of KEYS) {
    const com = read(`${LR}/${k}/comentarios.json`);
    const match = {};
    for (const f of fs.readdirSync(`${LR}/${k}`).filter((f) => /^opus-out\d+\.json$/.test(f))) Object.assign(match, read(`${LR}/${k}/${f}`));
    for (const [c, items] of Object.entries(com)) {
        const m = Object.fromEntries((match[c] || []).map((x) => [x.id, x.match]));
        for (const it of items) {
            if (!tpById.has(m[it.id])) continue;
            const raw = poolCase(k, c)[Number(it.id.slice(1)) - 1];
            if (!raw || raw.suggestionContent !== it.texto) throw new Error(`pool mismatch ${k} ${c} ${it.id}`);
            const list = cands.get(m[it.id]) || [];
            list.push({ run: k, caseId: c, id: it.id, origin: it.origem, finding: {
                label: raw.label,
                relevantFile: raw.relevantFile,
                relevantLinesStart: raw.relevantLinesStart,
                relevantLinesEnd: raw.relevantLinesEnd,
                suggestionContent: raw.suggestionContent,
            } });
            cands.set(m[it.id], list);
        }
    }
}

// Sample N, allocated by repo x severity.
const repoOf = (c) => path.basename(repos[c].repo);
const covered = [...cands.keys()].map((id) => tpById.get(id));
const strata = {};
for (const t of covered) (strata[`${repoOf(t.caseId)}|${t.severity}`] ||= []).push(t);
const alloc = Object.entries(strata).map(([s, xs]) => ({ s, xs, q: (xs.length * N) / covered.length }));
alloc.forEach((a) => (a.n = Math.floor(a.q)));
let left = N - alloc.reduce((n, a) => n + a.n, 0);
for (const a of [...alloc].sort((x, y) => y.q - Math.floor(y.q) - (x.q - Math.floor(x.q)) || rand(x.s) - rand(y.s))) {
    if (left-- <= 0) break;
    a.n++;
}
const sample = alloc.flatMap((a) => shuffle(a.xs.map((t) => t.issueId), a.s).slice(0, a.n)).map((id) => tpById.get(id));

// Split by PR: per repo, PRs go to test until ~40% of that repo's items.
const test = new Set();
for (const repo of new Set(sample.map((t) => repoOf(t.caseId)))) {
    const items = sample.filter((t) => repoOf(t.caseId) === repo);
    const prs = shuffle([...new Set(items.map((t) => t.caseId))], repo);
    let n = 0;
    const target = items.length * TEST_SHARE;
    for (const c of prs) {
        const k = items.filter((t) => t.caseId === c).length;
        if (Math.abs(n + k - target) >= Math.abs(n - target)) continue;
        test.add(c);
        n += k;
    }
}

// Frozen input per item.
const replaced = [];
const patches = new Map();
for (const f of fs.readdirSync(path.join(ROOT, 'evals/investigation/datasets')).filter((f) => f.endsWith('.json'))) {
    for (const row of [].concat(read(path.join(ROOT, 'evals/investigation/datasets', f)))) {
        const v = row && row.vars;
        if (v && v.caseId && Array.isArray(v.prFiles)) patches.set(v.caseId, new Map(v.prFiles.map((p) => [p.filename, p.patch || ''])));
    }
}
const headFile = (c, file) => {
    try {
        return execFileSync('git', ['-C', repos[c].repo, 'show', `${repos[c].head}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
};
const numbered = (content, from, to) =>
    content.split('\n').slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)} | ${l}`).join('\n');

// A finding production would never comment on (no file or lines, or a file
// outside the PR: parseFinderSchema and anchoring drop it) is no enrichment
// input. Such a draw is replaced by another TP of the same repo x severity
// whose candidates include a valid one, drawn among the valid ones only; the
// other items and the split stay as they were.
const prFilesOf = (c) => patches.get(c) || new Map();
const anchored = (c, f) => f.relevantFile && f.relevantLinesStart != null && f.relevantLinesEnd != null && prFilesOf(c).has(f.relevantFile);
const firstPick = (t) => cands.get(t.issueId)[Math.floor(rand(t.issueId) * cands.get(t.issueId).length)];
const picks = new Map();
const inSample = new Set(sample.map((t) => t.issueId));
for (let n = 0; n < sample.length; n++) {
    const t = sample[n];
    const pick = firstPick(t);
    if (anchored(t.caseId, pick.finding)) { picks.set(t.issueId, pick); continue; }
    const stratum = `${repoOf(t.caseId)}|${t.severity}`;
    const pool = shuffle(covered.filter((u) => !inSample.has(u.issueId) && cands.get(u.issueId).some((x) => anchored(u.caseId, x.finding))), `replace|${t.issueId}`);
    const sub = pool.find((u) => `${repoOf(u.caseId)}|${u.severity}` === stratum) || pool.find((u) => repoOf(u.caseId) === repoOf(t.caseId));
    if (!sub) throw new Error(`no replacement for ${t.issueId}`);
    const valid = cands.get(sub.issueId).filter((x) => anchored(sub.caseId, x.finding));
    picks.set(sub.issueId, valid[Math.floor(rand(sub.issueId) * valid.length)]);
    inSample.add(sub.issueId);
    sample[n] = sub;
    if (!test.has(sub.caseId) && !sample.some((u, i) => i !== n && u.caseId === sub.caseId)) {
        // a PR new to the sample joins the split that is further below its share
        const nTest = sample.filter((u) => test.has(u.caseId)).length;
        if (nTest < sample.length * TEST_SHARE) test.add(sub.caseId);
    }
    replaced.push({ out: t.issueId, in: sub.issueId });
}

const items = sample.map((t) => {
    const list = cands.get(t.issueId);
    const pick = picks.get(t.issueId);
    const f = pick.finding;
    const content = headFile(t.caseId, f.relevantFile);
    const det = enrichDeterministic(f, content);
    const total = content == null ? 0 : content.split('\n').length;
    const from = Math.max(1, (f.relevantLinesStart || 1) - WINDOW);
    const to = Math.min(total, (f.relevantLinesEnd || f.relevantLinesStart || 1) + WINDOW);
    return {
        issueId: t.issueId,
        caseId: t.caseId,
        repo: repoOf(t.caseId),
        headSha: repos[t.caseId].head,
        split: test.has(t.caseId) ? 'test' : 'dev',
        gold: { comment: t.commentOpus || t.comment, severity: t.severity, category: t.category },
        provenance: { run: pick.run, id: pick.id, origin: pick.origin, candidates: list.length },
        finding: f,
        deterministic: det,
        rangeSize: (f.relevantLinesEnd ?? f.relevantLinesStart) - f.relevantLinesStart + 1,
        context: {
            window: content == null ? '' : numbered(content, from, to),
            windowLines: [from, to],
            filePatch: patches.get(t.caseId)?.get(f.relevantFile) ?? '',
        },
    };
});

fs.mkdirSync(OUT, { recursive: true });
const body = JSON.stringify({ version: SEED, items }, null, 1);
fs.writeFileSync(path.join(OUT, 'items.json'), body);
const count = (fn) => items.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});
console.log({
    covered: covered.length,
    items: items.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16),
    split: count((x) => x.split),
    prs: { dev: new Set(items.filter((x) => x.split === 'dev').map((x) => x.caseId)).size, test: test.size },
    repo: count((x) => x.repo),
    severity: count((x) => x.gold.severity),
    anchor: count((x) => x.deterministic.anchorStatus),
    range15plus: items.filter((x) => x.rangeSize >= 15).length,
    run: count((x) => x.provenance.run),
    replaced,
});
process.exit(0);
