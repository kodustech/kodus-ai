// Kody-rules adherence — SHARDED SINGLE-SHOT EXPERIMENT (issue #1449).
//
// Hypothesis under test: breadth-coverage recall is an ARCHITECTURE problem,
// not a prompt problem. Instead of one agentic multi-turn loop that DECIDES
// which files to open (and starves on large PRs), we iterate files
// DETERMINISTICALLY in code and make ONE single-shot LLM call per (file, rule)
// with NO tools and a forced enumerated output. Coverage becomes a structural
// guarantee, not something the model has to remember to do.
//
//   node evals/kody-rules/sharded-experiment.js [--model=gpt-5.4-mini] [--runs=1] [--limit=N] [--conc=4]
//
// Reuses the SAME fixtures (github-cases.json) and the SAME occurrence-recall
// metric as real-agent.js, so the number is apples-to-apples with the agentic
// engine (which measured ~36-53% on gpt-5.4). Model routing goes through the
// same production seam (byokToVercelModel via applyModelEnv), so --model matches.
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
const RUNS = +(args.runs || 1);
const MODELKEY = args.model || 'gpt-5.4-mini';
const CONC = +(args.conc || 4);
// Some models (kimi-k2.7) reject temperature != 1. Default 0 for determinism;
// override with --temp=1 for those, or --temp=none to omit it entirely.
const TEMP = args.temp === 'none' ? undefined : +(args.temp ?? 0);
const LINE_TOL = 2;

const allCases = require('./github-cases.json');
const cases = args.limit ? allCases.slice(0, +args.limit) : allCases;

function normalizePath(v) { return String(v || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/'); }

// --- structured single-shot judge for ONE file × ONE rule (no tools) ---------
const SYSTEM = `You check a SINGLE team rule against the diff of a SINGLE file. Your only job: report EVERY line in this file's diff that violates the rule — one entry per violating line, not just the first.

Rules of engagement:
- Only flag lines ADDED in this diff. In the diff, an added line is prefixed with its file line number then a '+'. Lines without '+' are unchanged context — NEVER flag them.
- If the same rule is broken on several lines, emit a SEPARATE entry for EACH line.
- If no added line violates the rule, return an empty list.
- Do NOT report anything unrelated to THIS one rule. Do not look for other bugs.`;

function buildPrompt(rule, file) {
    const parts = [
        `<Rule>`,
        `Title: ${rule.title}`,
        `Description: ${rule.rule}`,
    ];
    if (rule.examples && rule.examples.length) {
        parts.push(`Examples:`);
        for (const ex of rule.examples) parts.push(`- ${ex.isCorrect ? 'Correct' : 'Incorrect'}:\n${ex.snippet}`);
    }
    parts.push(`</Rule>`, ``, `<File path="${file.filename}">`);
    parts.push(`Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`);
    parts.push('```diff', file.patchWithLinesStr || file.patch || '', '```', `</File>`, ``);
    parts.push(`Return ONLY JSON, no prose:`);
    parts.push(`{"violations":[{"line":<file line number of the added violating line>,"code":"<the offending code>"}]}`);
    parts.push(`Include EVERY violating added line. If none, return {"violations":[]}.`);
    return parts.join('\n');
}

function parseViolations(text) {
    if (!text) return [];
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let obj = tryParse(text.trim());
    if (!obj) {
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) obj = tryParse(fence[1].trim());
    }
    if (!obj) {
        const a = text.indexOf('{'), b = text.lastIndexOf('}');
        if (a !== -1 && b > a) obj = tryParse(text.slice(a, b + 1));
    }
    const vs = obj && Array.isArray(obj.violations) ? obj.violations : [];
    return vs.map((v) => ({ line: Number(v.line), code: v.code }))
        .filter((v) => Number.isFinite(v.line));
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }));
    return out;
}

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let inTok = 0, outTok = 0, cacheRead = 0, dumped = false;
    async function judge(rule, file) {
        const res = await generateText({ model, system: SYSTEM, prompt: buildPrompt(rule, file), ...(TEMP === undefined ? {} : { temperature: TEMP }) });
        const u = res.usage || {};
        const pm = res.providerMetadata || {};
        if (!dumped) { dumped = true; console.error('DEBUG usage=' + JSON.stringify(u) + ' providerMetadata=' + JSON.stringify(pm).slice(0, 400)); }
        inTok += u.promptTokens ?? u.inputTokens ?? 0;
        outTok += u.completionTokens ?? u.outputTokens ?? 0;
        // cache-read lives in different spots by provider/SDK version — probe all.
        const anyPm = Object.values(pm)[0] || {};
        cacheRead += u.cachedInputTokens ?? u.cacheReadTokens ?? anyPm.cachedPromptTokens ?? anyPm.cached_tokens ?? anyPm.promptCacheHitTokens ?? 0;
        return parseViolations(res.text).map((v) => ({ file: normalizePath(file.filename), line: v.line }));
    }

    // metric accumulators (mirror real-agent.js semantics)
    let multiTotalSites = 0, multiCaughtSites = 0;   // file-level recall
    let occTotal = 0, occCaught = 0;                 // occurrence recall
    let lineNoiseTotal = 0, flaggedTotal = 0;        // line precision
    let cleanFiles = 0, falseAlarmFiles = 0;         // specificity
    let calls = 0, errored = 0;

    for (const c of cases) {
        const rule = c.rule;
        const files = c.realChangedFiles;
        const violFiles = (c.violatingFiles || []).map(normalizePath);
        const okFiles = (c.cleanFiles || []).map(normalizePath);
        const sites = Object.entries(c.groundTruth || {})
            .flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));

        const perRun = [];
        for (let r = 0; r < RUNS; r++) {
            // DETERMINISTIC fan-out: one shard per changed file (in code, not LLM).
            const flagsNested = await mapLimit(files, CONC, async (f) => {
                calls++;
                try { return await judge(rule, f); }
                catch (e) { errored++; console.error(`  [${c.rule.uuid} ${f.filename}] ${String(e.message).slice(0, 120)}`); return []; }
            });
            const flags = flagsNested.flat();
            const flaggedFiles = new Set(flags.map((x) => x.file));
            const hit = violFiles.filter((f) => flaggedFiles.has(f)).length;
            const falseOnClean = okFiles.filter((f) => flaggedFiles.has(f)).length;
            const coveredSites = sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            const onTarget = flags.filter((x) => sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            perRun.push({ hit, falseOnClean, coveredSites, flags: flags.length, lineNoise: flags.length - onTarget });
        }
        const N = violFiles.length;
        multiTotalSites += N * RUNS; multiCaughtSites += perRun.reduce((a, b) => a + b.hit, 0);
        cleanFiles += okFiles.length * RUNS; falseAlarmFiles += perRun.reduce((a, b) => a + b.falseOnClean, 0);
        occTotal += sites.length * RUNS; occCaught += perRun.reduce((a, b) => a + b.coveredSites, 0);
        lineNoiseTotal += perRun.reduce((a, b) => a + b.lineNoise, 0); flaggedTotal += perRun.reduce((a, b) => a + b.flags, 0);
        console.log(`${c.rule.uuid.padEnd(22)} files=${files.length} sites=${sites.length}  occ-caught/run=[${perRun.map((p) => p.coveredSites).join(',')}]  flags/run=[${perRun.map((p) => p.flags).join(',')}]`);
    }

    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    console.log(`\n════ kody-rules — SHARDED SINGLE-SHOT (${MODELKEY}, ${RUNS} run/case, 1 call/file, no tools) ════`);
    console.log(`FILE-level recall:    ${pct(multiCaughtSites, multiTotalSites)}%  (${multiCaughtSites}/${multiTotalSites} violating files flagged ≥once)`);
    console.log(`OCCURRENCE recall:    ${pct(occCaught, occTotal)}%  (${occCaught}/${occTotal} real in-diff sites flagged, ±${LINE_TOL} lines)`);
    console.log(`line precision:       ${pct(flaggedTotal - lineNoiseTotal, flaggedTotal)}%  (${lineNoiseTotal}/${flaggedTotal} flags off any real site)`);
    console.log(`specificity (files):  ${pct(cleanFiles - falseAlarmFiles, cleanFiles)}%  (${falseAlarmFiles}/${cleanFiles} clean files false-alarmed)`);
    console.log(`LLM calls: ${calls} (${errored} errored) over ${cases.length} PRs`);
    console.log(`TOKENS: input=${inTok}  output=${outTok}  cacheRead=${cacheRead}  total=${inTok + outTok}  (avg ${Math.round((inTok + outTok) / Math.max(calls, 1))}/call)`);
}

main().catch((e) => { console.error(e); process.exit(2); });
