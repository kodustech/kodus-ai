#!/usr/bin/env node
/**
 * Build a replay dataset from REAL finder executions (Langfuse traces), not a
 * fabricated diff dump. For each benchmark PR it finds the matching finder trace,
 * pulls the actual tool calls (readFile / grep / findFile / listDir) with their
 * recorded outputs, and reports a FAIRNESS check: were the files where the golden
 * bugs live actually read in that execution? (A golden whose file was never read
 * can't be a recognition miss — it's a replay artifact.)
 *
 * This first pass extracts + audits. Full-content backing (fetch whole files from
 * the repo so ranges/greps flex) is a follow-up once the mapping is proven.
 *
 *   node extract-replay-from-trace.js --env verify-gemini \
 *     --from 2026-06-22T21:00:00Z --to 2026-06-23T00:30:00Z [--head <branch>] [--write]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '../..');
const BENCHMARK = path.join(ROOT, 'scripts/benchmark/prs-benchmark.json');
const LF_URL = 'https://us.cloud.langfuse.com';

function cfg(key) {
    let v = process.env[key];
    if (v) return v;
    try {
        for (const line of fs.readFileSync(path.join(os.homedir(), '.kodus-dev', 'config'), 'utf8').split('\n')) {
            const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)`));
            if (m) return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
        }
    } catch {}
    return null;
}

const PK = cfg('LANGFUSE_PUBLIC_KEY');
const SK = cfg('LANGFUSE_SECRET_KEY');
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
}
const FLAG = (name) => process.argv.includes(`--${name}`);

async function lf(pathname) {
    const r = await fetch(`${LF_URL}${pathname}`, { headers: { Authorization: AUTH } });
    if (!r.ok) throw new Error(`langfuse ${r.status} on ${pathname}`);
    return r.json();
}

const { execFileSync } = require('child_process');

// The head branch is NOT in the trace; the reliable key is the changed-file set.
// Pull file basenames from the trace's diff blob and from each PR (via gh), then
// match by overlap.
function fileBasenames(text) {
    const paths = String(text || '').match(/[\w./-]+\.(?:java|py|go|ts|tsx|js|jsx|rb|properties|sql|yaml|yml|json|prisma|erb)/g) || [];
    return new Set(paths.map((p) => p.split('/').pop().toLowerCase()));
}

function traceFiles(trace) {
    return fileBasenames(JSON.stringify(trace.input || ''));
}

// Fetch the PR's changed files via gh. source_url is either a /pull/<n> or a
// /commit/<sha> URL — handle both.
const prFilesCache = {};
function ghFiles(apiPath, jq) {
    try {
        const out = execFileSync('gh', ['api', apiPath, '--paginate', '--jq', jq], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return new Set(out.split('\n').filter(Boolean).map((f) => f.split('/').pop().toLowerCase()));
    } catch {
        return new Set();
    }
}
function prFiles(pr) {
    const url = String(pr.source_url || '');
    if (prFilesCache[url]) return prFilesCache[url];
    let names = new Set();
    const pull = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    const commit = url.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]+)/);
    if (pull) names = ghFiles(`repos/${pull[1]}/${pull[2]}/pulls/${pull[3]}/files`, '.[].filename');
    else if (commit) names = ghFiles(`repos/${commit[1]}/${commit[2]}/commits/${commit[3]}`, '.files[].filename');
    prFilesCache[url] = names;
    return names;
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

const DATASETS_DIR = path.join(__dirname, 'datasets');

// Full RAW file content at a ref (for the readFile corpus, so ranges/greps flex).
const contentCache = {};
function ghContent(owner, repo, filePath, ref) {
    const key = `${owner}/${repo}@${ref}:${filePath}`;
    if (key in contentCache) return contentCache[key];
    let content = null;
    try {
        const b64 = execFileSync('gh', ['api', `repos/${owner}/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${ref}`, '--jq', '.content'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        content = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
    } catch {
        content = null;
    }
    contentCache[key] = content;
    return content;
}

// Inject the trace's real cross-file exploration (read files) into a base
// dataset's readFile corpus, with FULL content fetched from the repo. Returns
// { added, total } or null if the base dataset can't be found.
function injectExecutionReplay(pr, readPaths) {
    const files = fs.readdirSync(DATASETS_DIR).filter((f) => f.endsWith('.json') && f !== 'smoke.json');
    let target = null;
    for (const f of files) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, f), 'utf8'));
            const c = Array.isArray(raw) ? raw[0] : raw;
            if (c.vars && c.vars.benchmarkSourceUrl === pr.source_url) { target = { f, raw, c }; break; }
        } catch {}
    }
    if (!target) return null;
    const { c } = target;
    const replay = JSON.parse(c.vars.toolReplay || '{}');
    const corpus = Array.isArray(replay.readFile) ? replay.readFile : [];
    const have = new Set(corpus.map((e) => e.match && e.match.path));
    const m = String(pr.source_url || '').match(/github\.com\/([^/]+)\/([^/]+)\//);
    const ref = c.vars.benchmarkHeadRef;
    let added = 0;
    if (m && ref) {
        for (const p of readPaths) {
            if (have.has(p)) continue;
            const content = ghContent(m[1], m[2], p, ref);
            if (content != null) { corpus.push({ match: { path: p }, result: content }); have.add(p); added++; }
        }
    }
    replay.readFile = corpus;
    c.vars.toolReplay = JSON.stringify(replay);
    fs.writeFileSync(path.join(DATASETS_DIR, target.f), JSON.stringify(target.raw, null, 2));
    return { added, total: corpus.length, file: target.f };
}

function toolCalls(trace) {
    return (trace.observations || [])
        .filter((o) => o.type === 'TOOL')
        .map((o) => ({ name: o.name, input: o.input, output: o.output }));
}

async function main() {
    const env = arg('env', 'verify-gemini');
    const from = arg('from', '2026-06-22T21:00:00Z');
    const to = arg('to', '2026-06-23T00:30:00Z');
    const onlyHead = arg('head', null);

    const prs = JSON.parse(fs.readFileSync(BENCHMARK, 'utf8')).prs;
    const list = await lf(
        `/api/public/traces?environment=${env}&name=kodus-generalist-review-agent&limit=100&fromTimestamp=${from}&toTimestamp=${to}`,
    );
    console.log(`benchmark PRs: ${prs.length} · finder traces (${env}): ${list.meta.totalItems}`);

    // Pull every trace once (with observations).
    const traces = [];
    for (const t of list.data) {
        const full = await lf(`/api/public/traces/${t.id}`);
        traces.push(full);
        process.stderr.write(`\rpulled ${traces.length}/${list.data.length} traces`);
    }
    process.stderr.write('\n');

    // Precompute each trace's changed-file set once.
    const traceFileSets = traces.map((tr) => ({ tr, files: traceFiles(tr) }));

    // Map each PR to the trace with the highest changed-file overlap (Jaccard).
    const rows = [];
    const usedTrace = new Set();
    for (const pr of prs) {
        if (onlyHead && pr.head !== onlyHead) continue;
        const repo = String(pr.repo).split('/').pop().toLowerCase();
        const want = prFiles(pr);
        let best = null;
        let bestScore = 0;
        for (const { tr, files } of traceFileSets) {
            if (usedTrace.has(tr.id)) continue;
            const s = jaccard(want, files);
            if (s > bestScore) { bestScore = s; best = tr; }
        }
        process.stderr.write(`\rmatching ${rows.length + 1}/${prs.length}`);
        const tr = bestScore >= 0.15 ? best : null;
        if (!tr) { rows.push({ head: pr.head, repo, matched: false, score: bestScore }); continue; }
        usedTrace.add(tr.id);

        const calls = toolCalls(tr);
        const readPaths = [...new Set(calls.filter((c) => c.name === 'readFile').map((c) => (c.input || {}).path).filter(Boolean))];
        const greps = calls.filter((c) => c.name === 'grep').length;
        // fairness: do the golden-relevant files show up in what was read?
        const goldenFiles = (pr.golden_comments || [])
            .map((g) => g.file || g.relevantFile || g.path)
            .filter(Boolean);
        const readBlob = readPaths.join('\n').toLowerCase();
        const goldenCovered = goldenFiles.length
            ? goldenFiles.filter((f) => readBlob.includes(String(f).toLowerCase().split('/').pop())).length
            : null;

        let inject = null;
        if (FLAG('write')) {
            inject = injectExecutionReplay(pr, readPaths);
            process.stderr.write(`\rwriting ${rows.length + 1}/${prs.length}`);
        }

        rows.push({
            head: pr.head,
            repo,
            matched: true,
            score: bestScore,
            traceId: tr.id,
            readFiles: readPaths.length,
            greps,
            goldens: (pr.golden_comments || []).length,
            goldenFiles: goldenFiles.length,
            goldenCovered,
            inject,
        });
    }
    process.stderr.write('\n');

    console.log('\n=== per-PR extraction audit ===');
    for (const r of rows) {
        if (!r.matched) { console.log(`  ✗ ${r.head} (${r.repo}) — NO TRACE MATCH (best overlap ${(r.score || 0).toFixed(2)})`); continue; }
        const inj = r.inject ? `→ corpus +${r.inject.added} (=${r.inject.total})` : (r.inject === null && FLAG('write') ? '→ NO BASE DATASET' : '');
        console.log(`  ✓ ${r.head.slice(0, 40).padEnd(40)} readFiles=${String(r.readFiles).padStart(2)} grep=${String(r.greps).padStart(2)} goldens=${r.goldens} ${inj}`);
    }
    const matched = rows.filter((r) => r.matched).length;
    console.log(`\nmatched ${matched}/${rows.length} PRs to a trace`);
}

main().catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
