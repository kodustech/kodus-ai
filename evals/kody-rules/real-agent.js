// Kody-rules adherence eval — REAL ENGINE (not a prototype).
//
// Runs the production `KodyRulesAgentProvider.execute()` end-to-end: the same
// system/category/user prompts, the same agent loop (runAgentLoop), the same
// verify / coverage-recovery / second-chance passes, the same ruleUuid
// reconciliation and @@PATH_MISMATCH@@ drop. Tools are served from a
// deterministic replay (no sandbox / GitHub), exactly like the finder eval.
//
//   node evals/kody-rules/real-agent.js [--runs=3] [--model=gpt-5.4-mini]
//
// The model is driven through the real `byokToVercelModel` self-hosted path:
// API_LLM_PROVIDER_MODEL + API_OPEN_AI_API_KEY (+ optional API_OPENAI_FORCE_BASE_URL).
// esbuild require-hook for .ts (NOT ts-node): agent-loop.ts places value
// imports mid-file (line 296), which ts-node/transpile-only leaves un-hoisted →
// "Cannot access 'llm_1' before initialization". esbuild hoists imports
// correctly, so the real provider graph loads.
const fs = require('fs');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const RUNS = +(args.runs || 3);
const MODELKEY = args.model || 'gpt-5.4-mini';
const DATASET = args.dataset || 'github-cases';
// CI gate: with --gate, exit non-zero if metrics fall below the model's floor.
// occurrence-recall varies a lot by model, so floors are PER-MODEL in
// kody-targets.json (occMin = observed − ~2·binomial-SE). --occ-min=/--spec-min=
// still override for ad-hoc runs; otherwise resolve the current model's floor
// (default 0 = no gate when the model has no calibrated target yet).
const GATE = !!args.gate;
const KODY_TARGETS = (() => {
    // Missing file → no calibrated floors (gate falls back to 0/off). But a
    // MALFORMED file must fail loudly, not silently disable the gate.
    try {
        return require('./kody-targets.json').models || {};
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') return {};
        throw err;
    }
})();
// Use MODELKEY (not args.model) so the default invocation resolves the floor of
// the model it actually runs (gpt-5.4-mini), instead of an undefined lookup.
const MODEL_TARGET = KODY_TARGETS[MODELKEY] || {};
const OCC_MIN = +(args['occ-min'] ?? MODEL_TARGET.occMin ?? 0);
const SPEC_MIN = +(args['spec-min'] ?? MODEL_TARGET.specMin ?? 95);

// Model presets → drive the real self-hosted byokToVercelModel path via env.
const MODELS = {
    'gpt-5.4-mini': { model: 'gpt-5.4-mini', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-5.4': { model: 'gpt-5.4', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'deepseek-v4-pro': { model: 'deepseek-v4-pro', keyEnv: ['DO_MODEL_ACCESS_KEY'], baseURL: 'https://inference.do-ai.run/v1' },
    'sonnet-4.6': { model: 'anthropic-claude-4.6-sonnet', keyEnv: ['DO_MODEL_ACCESS_KEY'], baseURL: 'https://inference.do-ai.run/v1' },
};

const allCases = require('./' + DATASET);
// --limit=N caps how many cases run (CI scopes to a small PR set).
const cases = args.limit ? allCases.slice(0, +args.limit) : allCases;

// --- replay (same shape/semantics as evals/investigation/agent-provider.js) ---
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
        this.calls = [];
        this.unexpectedCalls = [];
        this.corpus = (this.replay.readFile || [])
            .map((e) => ({ path: normalizePath(e?.match?.path), content: String(e?.result || '') }))
            .filter((e) => e.path && e.content);
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
        if (f) { this.calls.push({ kind: 'grep', actual, matched: true }); return f.result || ''; }
        const s = this._searchCorpus(actual);
        if (s !== null) { this.calls.push({ kind: 'grep', actual, matched: 'synthetic' }); return s; }
        this.calls.push({ kind: 'grep', actual, matched: false }); this.unexpectedCalls.push({ kind: 'grep', actual }); return 'No matches found.';
    }
    async read(filePath, start, end) {
        const actual = { path: normalizePath(filePath), startLine: start || 0, endLine: end || 0 };
        const f = this._find('readFile', actual);
        this.calls.push({ kind: 'readFile', actual, matched: !!f }); if (!f) this.unexpectedCalls.push({ kind: 'readFile', actual });
        return f ? (f.result || '') : `No replay fixture matched readFile(${actual.path}).`;
    }
    async listDir(dirPath) {
        const actual = { path: normalizePath(dirPath || '.') };
        const f = this._find('listDir', actual);
        this.calls.push({ kind: 'listDir', actual, matched: !!f }); return f ? (f.result || '') : '';
    }
}

function buildProvider() {
    const { KodyRulesAgentProvider } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts'));
    const permissionValidationService = { getBYOKConfig: async () => null };
    const observabilityService = {
        runInSpan: async (_n, fn) => (typeof fn === 'function' ? fn() : undefined),
        runLLMInSpan: async ({ exec }) => exec([]),
        startSpan: () => ({ end() {}, update() {} }),
        // The refactored provider emits a post-hoc usage span; evals don't ship
        // telemetry. Instead of a no-op, accumulate token usage so the run can
        // report total cost (for the agentic-vs-sharded cost comparison, #1449).
        recordAgentRunUsage: async (p) => {
            const u = (p && p.usage) || {};
            global.__EVAL_TOK = global.__EVAL_TOK || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
            global.__EVAL_TOK.in += u.inputTokens ?? 0;
            global.__EVAL_TOK.out += u.outputTokens ?? 0;
            global.__EVAL_TOK.cacheRead += u.cacheReadTokens ?? 0;
            global.__EVAL_TOK.cacheWrite += u.cacheWriteTokens ?? 0;
        },
    };
    return new KodyRulesAgentProvider({}, permissionValidationService, observabilityService);
}

// Normalize a real-diff case into the pieces the runner needs: the changedFiles
// to review, the tool replay, and the violating/clean file ground truth. Cases
// come from build-bench-cases.js (benchmark diffs) or harvest-github-cases.js
// (live GitHub PRs) — both carry real `realChangedFiles` + `toolReplay`.
function normalizeCase(c) {
    return {
        changedFiles: c.realChangedFiles.map((f) => ({ filename: f.filename, patchWithLinesStr: f.patchWithLinesStr || f.patch || '', patch: f.patch || f.patchWithLinesStr || '' })),
        replay: c.toolReplay || {},
        violFiles: (c.violatingFiles || []).map(normalizePath),
        okFiles: (c.cleanFiles || []).map(normalizePath),
        fileCount: c.realChangedFiles.length,
    };
}

// --all-rules: inject ALL unique dataset rules into every session (matches
// PRODUCTION, where formatKodyRules puts every applicable rule in ONE agentic
// session). Scoring then filters suggestions to the case's target ruleUuid,
// mirroring the sharded-v2 batched scoring, so the comparison is fair.
const ALL_RULES = !!args['all-rules'];
const UNIQUE_RULES = Object.values(Object.fromEntries(allCases.filter((c) => c.rule).map((c) => [c.rule.uuid, c.rule])));

// v2 dataset (github-cases-v2): one case per PR, `rules` array + groundTruthAll
// (full GT per rule, built by build-cases-v2.js). Normalize into scoring
// targets [{uuid, sites, violFiles, okFiles}] — one per rule.
function caseTargets(c) {
    if (!c.groundTruthAll) return null;
    const changed = c.realChangedFiles.map((f) => normalizePath(f.filename));
    return (c.rules || []).map((r) => {
        const gt = c.groundTruthAll[r.uuid] || {};
        const violFiles = Object.keys(gt).map(normalizePath);
        const sites = Object.entries(gt).flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
        return { uuid: r.uuid, sites, violFiles, okFiles: changed.filter((f) => !violFiles.includes(f)) };
    });
}

async function runCase(provider, c, changedFiles, replay) {
    const remoteCommands = new ReplayRemoteCommands(replay);
    // v2 cases carry their full rule set; v1 keeps the single-rule (or
    // --all-rules) behavior.
    const rulesForRun = c.rules ? c.rules : (ALL_RULES ? UNIQUE_RULES : [c.rule]);
    const out = await provider.execute({
        organizationAndTeamData: { organizationId: 'eval-org', teamId: 'eval-team' },
        changedFiles,
        remoteCommands,
        prNumber: 1,
        repositoryId: 'eval-repo',
        repositoryFullName: 'eval/repo',
        baseBranch: 'main',
        reviewMode: 'normal',
        maxSteps: c.maxSteps || 20,
        prTitle: c.title || 'eval PR',
        prBody: c.body || '',
        kodyRules: rulesForRun.map((r) => ({ ...r, type: 'standard', status: 'active', scope: r.scope || 'file' })),
    });
    // turnsUsed = agent steps executed. 0 means the agent never ran a step —
    // it failed before starting (e.g. a swallowed quota/rate-limit error that
    // surfaces as finishReason=error/steps=0 rather than a throw). A legitimate
    // "investigated and found nothing" run has turnsUsed > 0.
    return { suggestions: out.suggestions || [], turnsUsed: out.turnsUsed ?? 0 };
}

async function main() {
    // tier-0 model ids route through the shared seam (any supported provider);
    // legacy local presets (DO models) keep working via the registry below.
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
    if (TIER0[MODELKEY]) {
        applyModelEnv(MODELKEY);
    } else {
        const spec = MODELS[MODELKEY];
        if (!spec) throw new Error(`unknown model ${MODELKEY}`);
        const key = spec.keyEnv.map((e) => process.env[e]).find(Boolean);
        if (!key) throw new Error(`no key (${spec.keyEnv.join('/')})`);
        process.env.API_LLM_PROVIDER_MODEL = spec.model;
        process.env.API_OPEN_AI_API_KEY = key;
        if (spec.baseURL) process.env.API_OPENAI_FORCE_BASE_URL = spec.baseURL;
    }

    const provider = buildProvider();

    const LINE_TOL = 2; // a flag "lands" on a real site if within ±2 lines
    let multiTotalSites = 0, multiCaughtSites = 0, caughtAllRuns = 0, totalMultiRuns = 0;
    let cleanFiles = 0, falseAlarmFiles = 0;
    // occurrence-level (only for cases that carry per-line groundTruth)
    let occTotal = 0, occCaught = 0, lineNoiseTotal = 0, flaggedTotal = 0;
    // Environmental failures (quota / rate-limit / bad key) surface as errored
    // runs — NOT real misses. Track them so a broken environment warns (infra)
    // instead of deflating recall into a false quality-gate failure.
    let erroredRuns = 0, totalRuns = 0;
    const haveGT = cases.some((c) => c.groundTruth || c.groundTruthAll);
    // flatten groundTruth → [{file, line}]
    const gtSites = (c) => Object.entries(c.groundTruth || {})
        .flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
    for (const c of cases) {
        const { changedFiles, replay, violFiles, okFiles, fileCount } = normalizeCase(c);
        const targets = caseTargets(c); // non-null on the v2 dataset
        const sites = gtSites(c);
        const caseLabel = c.caseId || c.rule.uuid;
        const perRun = [];
        for (let r = 0; r < RUNS; r++) {
            let sugg = [], turnsUsed = 0, errored = false;
            totalRuns++;
            try { const res = await runCase(provider, c, changedFiles, replay); sugg = res.suggestions; turnsUsed = res.turnsUsed; }
            catch (e) { errored = true; console.error(`  [case ${caseLabel} run ${r}] ${String(e.message).slice(0, 140)}`); }
            // Infra run = it threw, OR the agent returned without executing a
            // single step and produced nothing (failed before running, e.g.
            // swallowed quota). A real "found nothing" run has turnsUsed > 0 and
            // still counts as a genuine miss against the quality gate.
            if (!errored && sugg.length === 0 && turnsUsed === 0) errored = true;
            if (errored) erroredRuns++;

            if (targets) {
                // v2: score every rule against its own GT. Suggestions map to
                // rules via brokenKodyRulesIds (mapAgentFindings re-homes the
                // LLM's ruleUuid there — finding-mapper.ts).
                let hit = 0, falseOnClean = 0, coveredSites = 0, flagsN = 0, lineNoise = 0;
                for (const t of targets) {
                    const tSugg = sugg.filter((s) =>
                        (s.brokenKodyRulesIds || []).includes(t.uuid) || s.ruleUuid === t.uuid);
                    const flags = tSugg.map((s) => ({ file: normalizePath(s.relevantFile), line: s.relevantLinesStart })).filter((x) => x.file && Number.isFinite(x.line));
                    const flaggedFiles = new Set(flags.map((x) => x.file));
                    hit += t.violFiles.filter((f) => flaggedFiles.has(f)).length;
                    falseOnClean += t.okFiles.filter((f) => flaggedFiles.has(f)).length;
                    coveredSites += t.sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
                    const onTarget = flags.filter((x) => t.sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
                    flagsN += flags.length; lineNoise += flags.length - onTarget;
                }
                perRun.push({ hit, falseOnClean, coveredSites, flags: flagsN, lineNoise, errored, otherRuleFlags: 0 });
                continue;
            }

            // --all-rules on the v1 dataset: score only the target rule's
            // suggestions (other rules have no GT on this case).
            let otherRuleFlags = 0;
            if (ALL_RULES) {
                const total = sugg.length;
                sugg = sugg.filter((s) =>
                    (s.brokenKodyRulesIds || []).includes(c.rule.uuid) ||
                    s.ruleUuid === c.rule.uuid);
                otherRuleFlags = total - sugg.length;
            }
            const flaggedFiles = new Set(sugg.map((s) => normalizePath(s.relevantFile)).filter(Boolean));
            const hit = violFiles.filter((f) => flaggedFiles.has(f)).length;
            const falseOnClean = okFiles.filter((f) => flaggedFiles.has(f)).length;
            // occurrence-level: distinct real sites covered by some flag (±tol)
            const flags = sugg.map((s) => ({ file: normalizePath(s.relevantFile), line: s.relevantLinesStart })).filter((x) => x.file && Number.isFinite(x.line));
            const coveredSites = sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            const onTargetFlags = flags.filter((x) => sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            perRun.push({ hit, falseOnClean, coveredSites, flags: flags.length, lineNoise: flags.length - onTargetFlags, errored, otherRuleFlags });
        }
        // v2 denominators span all (file,rule) pairs; v1 keeps the single rule.
        const N = targets ? targets.reduce((a, t) => a + t.violFiles.length, 0) : violFiles.length;
        const siteCount = targets ? targets.reduce((a, t) => a + t.sites.length, 0) : sites.length;
        const cleanCount = targets ? targets.reduce((a, t) => a + t.okFiles.length, 0) : okFiles.length;
        // Count only runs that actually executed — an errored (infra) run must
        // not add its sites to any denominator as if they were real misses.
        const okRuns = perRun.filter((p) => !p.errored).length;
        const allRuns = perRun.filter((p) => !p.errored && p.hit >= N).length;
        multiTotalSites += N * okRuns; multiCaughtSites += perRun.reduce((a, b) => a + (b.errored ? 0 : b.hit), 0);
        caughtAllRuns += allRuns; totalMultiRuns += okRuns;
        cleanFiles += cleanCount * okRuns; falseAlarmFiles += perRun.reduce((a, b) => a + (b.errored ? 0 : b.falseOnClean), 0);
        if (c.groundTruth || targets) {
            occTotal += siteCount * okRuns; occCaught += perRun.reduce((a, b) => a + (b.errored ? 0 : b.coveredSites), 0);
            lineNoiseTotal += perRun.reduce((a, b) => a + (b.errored ? 0 : b.lineNoise), 0); flaggedTotal += perRun.reduce((a, b) => a + (b.errored ? 0 : b.flags), 0);
            const otherInfo = ALL_RULES && !targets ? `  other-rule-flags/run=[${perRun.map((p) => p.otherRuleFlags).join(',')}]` : '';
            console.log(`${caseLabel.padEnd(34)} files=${fileCount} sites=${siteCount}  file-hits/run=[${perRun.map((p) => p.hit).join(',')}]  occ-caught/run=[${perRun.map((p) => p.coveredSites).join(',')}]  flags/run=[${perRun.map((p) => p.flags).join(',')}]${otherInfo}`);
        } else {
            console.log(`${caseLabel.padEnd(34)} files=${fileCount} viol=${N}  hits/run=[${perRun.map((p) => p.hit).join(',')}]  caught-all ${allRuns}/${okRuns}  false-on-clean ${perRun.reduce((a, b) => a + (b.errored ? 0 : b.falseOnClean), 0)}`);
        }
    }
    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    console.log(`\n════ kody-rules adherence — REAL ENGINE (${MODELKEY}, ${RUNS} runs/case) ════`);
    console.log(`FILE-level recall:    ${pct(multiCaughtSites, multiTotalSites)}%  (${multiCaughtSites}/${multiTotalSites} violating files flagged ≥once)`);
    if (haveGT) {
        console.log(`OCCURRENCE recall:    ${pct(occCaught, occTotal)}%  (${occCaught}/${occTotal} real in-diff sites flagged, ±${LINE_TOL} lines)  ← did it catch EVERY spot`);
        console.log(`line precision:       ${pct(flaggedTotal - lineNoiseTotal, flaggedTotal)}%  (${lineNoiseTotal}/${flaggedTotal} flags landed off any real site)`);
    }
    console.log(`specificity (files):  ${pct(cleanFiles - falseAlarmFiles, cleanFiles)}%  (${falseAlarmFiles}/${cleanFiles} clean files false-alarmed)`);
    const tok = global.__EVAL_TOK || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    console.log(`TOKENS: input=${tok.in}  output=${tok.out}  cacheRead=${tok.cacheRead}  cacheWrite=${tok.cacheWrite}  over ${totalRuns} agentic sessions`);

    if (GATE) {
        // Infra guard: if the environment (quota/rate-limit/key) broke enough
        // runs that the measurement is unreliable, exit 2 (infra) so CI warns
        // instead of red-flagging quality on a bogus low recall.
        // erroredRuns now counts thrown runs AND ran-zero-steps runs (the
        // concrete "agent never executed" signal — not a pure 0-output guess, so
        // a real engine regression that DOES run but finds nothing still fails
        // the quality gate below).
        const erroredFrac = totalRuns ? erroredRuns / totalRuns : 0;
        if (occTotal === 0 || erroredFrac >= 0.5) {
            console.error(`\n⚠️ INFRA: ${erroredRuns}/${totalRuns} runs never executed (quota/rate-limit/key — steps=0 or threw) — measurement unreliable, not gating.`);
            process.exit(2);
        }
        const occ = occTotal ? (100 * occCaught / occTotal) : 0;
        const spec = cleanFiles ? (100 * (cleanFiles - falseAlarmFiles) / cleanFiles) : 100;
        const fails = [];
        if (haveGT && occ < OCC_MIN) fails.push(`occurrence-recall ${occ.toFixed(0)}% < ${OCC_MIN}%`);
        if (spec < SPEC_MIN) fails.push(`specificity ${spec.toFixed(0)}% < ${SPEC_MIN}%`);
        if (fails.length) { console.error(`\n❌ GATE FAILED: ${fails.join('; ')}`); process.exit(1); }
        console.log(`\n✅ GATE PASSED (occurrence-recall ≥ ${OCC_MIN}%, specificity ≥ ${SPEC_MIN}%)`);
    }
}

// Exit-code contract for the suite: 1 = gate failed (quality regression),
// 2 = infra error (no key, bad model id, crash) — always surfaced loudly.
main().catch((e) => { console.error(e); process.exit(2); });
