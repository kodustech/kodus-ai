// Anchoring eval — how many real finder findings are lost at the line-anchoring
// stage, and how many of those losses are recoverable near-misses?
//
// Runs the production finder (real GeneralistAgentProvider loop) over real
// benchmark PR diffs with deterministic tool replay, then applies the REAL
// production anchoring decision — `snapLinesToDiff` from agent-review.stage.ts —
// to each finding. A finding whose cited lines don't overlap ANY changed hunk is
// DROPPED (null) in production; this eval measures how often that happens and,
// for the drops, the distance to the nearest hunk (a near-miss is a finding the
// model anchored just outside the diff — a recoverable recall loss).
//
//   node evals/anchoring/anchor-eval.js [--limit=8] [--model=gpt-5.4-mini] [--tol=2]
//
// PHASE 1: no golden/TP attribution (golden comments carry no line). Measures
// the anchoring drop behavior on the finder's own findings. Phase 2 adds the
// recall-judge to label which drops were real bugs.

// esbuild require-hook (agent-loop.ts has mid-file imports ts-node won't hoist).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const LIMIT = +(args.limit || 8);
const MODELKEY = args.model || 'gpt-5.4-mini';
const TOL = +(args.tol || 2); // a drop within TOL lines of a hunk = recoverable near-miss
// CI gate: regression guard for the anchor-fix. The fix keeps anchoring drops at
// ~0; a regression makes verify-kept findings start dropping again. Hard-fail on
// any recoverable near-miss drop (a real TP lost off-by-a-few-lines) and on a
// drop-rate above --drop-max (default 8%, margin over the without-fix ~4%).
const GATE = !!args.gate;
const DROP_MAX = +(args['drop-max'] || 8);

const MODELS = {
    'gpt-5.4-mini': { provider: 'openai', model: 'gpt-5.4-mini', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-5.4': { provider: 'openai', model: 'gpt-5.4', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
};

// The REAL production anchoring decision.
const { snapLinesToDiff } = require('../../libs/code-review/pipeline/stages/agent-review.stage.ts');

// Valid right-side line ranges from the engine's patchWithLinesStr. Mirrors
// extractValidDiffLines (which parses a raw unified patch) — the benchmark
// datasets carry patchWithLinesStr, whose `NN +code`/`NN  code` lines ARE the
// right-side lines. Produces the same [start,end] hunk spans the real function
// would, so the snapLinesToDiff decision under test is identical.
function validRangesFromEnginePatch(patchWithLinesStr) {
    const ranges = [];
    let cur = null;
    for (const ln of String(patchWithLinesStr || '').split('\n')) {
        if (/^__old hunk__/.test(ln)) { if (cur) { ranges.push(cur); cur = null; } continue; }
        if (/^__new hunk__/.test(ln) || /^@@ /.test(ln) || /^## file:/.test(ln)) { if (cur) { ranges.push(cur); cur = null; } continue; }
        const m = ln.match(/^\s*(\d+)\s/); // right-side line number (added or context)
        if (!m) { if (cur) { ranges.push(cur); cur = null; } continue; }
        const n = +m[1];
        if (cur && n === cur[1] + 1) cur[1] = n;
        else { if (cur) ranges.push(cur); cur = [n, n]; }
    }
    if (cur) ranges.push(cur);
    return ranges;
}

function nearestHunkDistance(line, ranges) {
    let best = Infinity;
    for (const [rs, re] of ranges) {
        if (line >= rs && line <= re) return 0;
        best = Math.min(best, Math.abs(line < rs ? rs - line : line - re));
    }
    return best;
}

// ── replay (same semantics as the kody-rules / investigation harness) ──
function normalizePath(v) { return String(v || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/'); }
function fixtureMatches(match, actual) {
    return Object.entries(match || {}).every(([k, exp]) => {
        if (exp == null) return true;
        const a = actual[k];
        if (k.toLowerCase().includes('path')) return normalizePath(exp) === normalizePath(a);
        return exp === a;
    });
}
class ReplayRemoteCommands {
    constructor(replay) {
        this.replay = replay || {};
        this.calls = []; this.unexpectedCalls = [];
        this.corpus = (this.replay.readFile || []).map((e) => ({ path: normalizePath(e?.match?.path), content: String(e?.result || '') })).filter((e) => e.path && e.content);
    }
    _find(kind, actual) { return (this.replay[kind] || []).find((e) => fixtureMatches(e.match || {}, actual)) || null; }
    _searchCorpus(actual) {
        let rx; try { rx = new RegExp(String(actual.pattern || '')); } catch { rx = new RegExp(String(actual.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
        const out = [];
        for (const e of this.corpus) {
            if (actual.path && actual.path !== '.' && e.path !== actual.path && !e.path.startsWith(actual.path + '/')) continue;
            const lines = e.content.split('\n');
            for (let i = 0; i < lines.length; i++) { rx.lastIndex = 0; if (rx.test(lines[i])) { out.push(`${e.path}:${i + 1}:${lines[i]}`); if (out.length >= 40) return out.join('\n'); } }
        }
        return out.length ? out.join('\n') : null;
    }
    async grep(pattern, searchPath, glob) {
        const actual = { pattern: pattern || '', path: normalizePath(searchPath || '.'), glob: glob || '' };
        const f = this._find('grep', actual);
        if (f) { this.calls.push({ kind: 'grep', matched: true }); return f.result || ''; }
        const s = this._searchCorpus(actual);
        if (s !== null) { this.calls.push({ kind: 'grep', matched: 'synthetic' }); return s; }
        this.calls.push({ kind: 'grep', matched: false }); this.unexpectedCalls.push({ kind: 'grep', actual }); return 'No matches found.';
    }
    async read(filePath, start, end) {
        const actual = { path: normalizePath(filePath), startLine: start || 0, endLine: end || 0 };
        const f = this._find('readFile', actual);
        this.calls.push({ kind: 'readFile', matched: !!f }); if (!f) this.unexpectedCalls.push({ kind: 'readFile', actual });
        return f ? (f.result || '') : `No replay fixture matched readFile(${actual.path}).`;
    }
    async listDir(dirPath) {
        const f = this._find('listDir', { path: normalizePath(dirPath || '.') });
        this.calls.push({ kind: 'listDir', matched: !!f }); return f ? (f.result || '') : '';
    }
}

function parseMaybe(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }
function normalizeChangedFiles(files) {
    return (files || []).map((f) => ({ filename: normalizePath(f.filename || f.path), patchWithLinesStr: f.patchWithLinesStr || f.patch || '', patch: f.patch || f.patchWithLinesStr || '' }));
}

async function buildModel(spec) {
    const apiKey = spec.keyEnv.map((e) => process.env[e]).find(Boolean);
    if (!apiKey) throw new Error(`no key (${spec.keyEnv.join('/')})`);
    const { createOpenAI } = await import('@ai-sdk/openai');
    return createOpenAI(spec.baseURL ? { apiKey, baseURL: spec.baseURL } : { apiKey })(spec.model);
}

async function runFinder(model, caseData) {
    const { GeneralistAgentProvider } = require('../../libs/code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const { runAgentLoopViaCore: runAgentLoop } = require('../../libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts');
    const provider = new GeneralistAgentProvider({}, {}, {});
    const changedFiles = normalizeChangedFiles(parseMaybe(caseData.changedFiles));
    const input = {
        organizationAndTeamData: { organizationId: 'eval-org', teamId: 'eval-team' },
        changedFiles, remoteCommands: {}, prNumber: caseData.prNumber || 1,
        repositoryFullName: caseData.repositoryFullName || 'eval/repo',
        languageResultPrompt: '', memoryRules: [], prTitle: caseData.prTitle, prBody: caseData.prBody,
        reviewMode: 'normal', maxSteps: caseData.maxSteps || 14, baseBranch: 'main',
    };
    const remoteCommands = new ReplayRemoteCommands(parseMaybe(caseData.toolReplay) || {});
    const agentResult = await runAgentLoop(
        { model, systemPrompt: provider.buildSystemPrompt(input), userPrompt: provider.buildUserPrompt(input),
          changedFiles, prNumber: input.prNumber, repositoryFullName: input.repositoryFullName, baseBranch: 'main',
          reviewMode: 'normal', maxSteps: input.maxSteps, agentName: 'anchoring-eval' },
        { remoteCommands, byokConfig: undefined, byokErrorReporter: undefined },
    );
    return { findings: agentResult.findings?.suggestions || [], changedFiles };
}

async function main() {
    // tier-0 model ids build through the production byokToVercelModel routing
    // (any supported provider); legacy local presets build directly.
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
    let model;
    if (TIER0[MODELKEY]) {
        applyModelEnv(MODELKEY);
        const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
        model = byokToVercelModel(undefined, 'main', {});
    } else {
        const spec = MODELS[MODELKEY];
        if (!spec) throw new Error(`unknown model ${MODELKEY}`);
        model = await buildModel(spec);
    }

    const dsDir = path.join(__dirname, '../investigation/datasets');
    const files = fs.readdirSync(dsDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).slice(0, LIMIT);

    let total = 0, kept = 0, dropped = 0, nearMiss = 0, farOff = 0, noFile = 0;
    const dropDist = {};
    for (const fname of files) {
        const caseData = JSON.parse(fs.readFileSync(path.join(dsDir, fname), 'utf8'))[0].vars;
        let res;
        try { res = await runFinder(model, caseData); }
        catch (e) { console.error(`  [${fname.slice(0, 30)}] ${String(e.message).slice(0, 100)}`); continue; }
        const byFile = new Map(res.changedFiles.map((f) => [normalizePath(f.filename), validRangesFromEnginePatch(f.patchWithLinesStr)]));
        let cK = 0, cD = 0, cN = 0;
        for (const s of res.findings) {
            total++;
            const ranges = byFile.get(normalizePath(s.relevantFile));
            if (!ranges) { noFile++; dropped++; cD++; continue; } // relevantFile not in diff (file-level drop)
            const snapped = snapLinesToDiff(s, ranges);
            if (snapped !== null) { kept++; cK++; continue; }
            dropped++; cD++;
            const dist = nearestHunkDistance(s.relevantLinesStart || 0, ranges);
            dropDist[dist] = (dropDist[dist] || 0) + 1;
            if (dist <= TOL) { nearMiss++; cN++; } else farOff++;
        }
        console.log(`${fname.replace('.json', '').slice(0, 48).padEnd(48)} findings=${res.findings.length}  kept=${cK} dropped=${cD} (near-miss≤${TOL}=${cN})`);
    }

    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    console.log(`\n════ anchoring (finder=${MODELKEY}, ${files.length} PRs, real snapLinesToDiff) ════`);
    console.log(`findings total:        ${total}`);
    console.log(`KEPT (anchored):       ${kept} (${pct(kept, total)}%)`);
    console.log(`DROPPED at anchoring:  ${dropped} (${pct(dropped, total)}%)  — incl. ${noFile} relevantFile-not-in-diff`);
    console.log(`  ↳ near-miss (≤${TOL} lines from a hunk): ${nearMiss} (${pct(nearMiss, dropped)}% of drops)  ← RECOVERABLE leak`);
    console.log(`  ↳ far-off (>${TOL} lines):               ${farOff} (${pct(farOff, dropped)}% of drops)  ← likely off-diff/hallucination`);
    console.log(`drop distance histogram (lines→count):`, JSON.stringify(dropDist));

    if (GATE) {
        const dropRate = total ? (100 * dropped / total) : 0;
        const fails = [];
        if (nearMiss > 0) fails.push(`${nearMiss} recoverable near-miss drop(s) (≤${TOL} lines) — verify-kept findings lost off-by-a-few-lines`);
        if (dropRate > DROP_MAX) fails.push(`anchoring drop-rate ${dropRate.toFixed(0)}% > ${DROP_MAX}% — anchor-fix may have regressed`);
        if (fails.length) { console.error(`\n❌ GATE FAILED: ${fails.join('; ')}`); process.exit(1); }
        console.log(`\n✅ GATE PASSED (near-miss drops = 0, drop-rate ≤ ${DROP_MAX}%)`);
    }
}

// Exit-code contract for the suite: 1 = gate failed, 2 = infra error
// (no key, bad model id, crash) — always surfaced loudly.
main().catch((e) => { console.error(e); process.exit(2); });
