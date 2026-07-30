// Kody-rules — SHARDED v2: production-adherent suite (issue #1449).
//
// v1 (sharded-experiment.js) proved the architecture on the simplest regime:
// ONE rule per case, one single-shot call per file. Production is not that:
// many rules apply to each file, some rules carry a reference file, and some
// are PR-scoped. This suite tests those regimes with the SAME fixtures/metric:
//
//   A) BATCHED   — one call per file with ALL path-matching rules (the real
//                  prod regime; amortizes per-call reasoning across R rules —
//                  this is what keeps cost ≤ agentic when R grows).
//   B) PR-LEVEL  — one whole-PR call per rule with scope=pull_request
//                  (rule: "PR changing source must include a test change";
//                  deterministic GT from the fixture file lists).
//   C) REFERENCE — rule that cites a reference file; the shard inlines the
//                  reference content (deterministic pre-fetch, still no tools).
//
//   node evals/kody-rules/sharded-v2.js [--model=kimi-k2.7-code] [--temp=1] [--conc=2] [--exp=A,B,C]
//
// Cost is reported at REAL kimi-k2.7 pricing: $0.95/M input (cache miss),
// $0.16/M cached input, $4.00/M output. Compare against the measured agentic
// baseline on the same 14 PRs: 58% occ-recall, $0.331 total.
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
const MODELKEY = args.model || 'kimi-k2.7-code';
const CONC = +(args.conc || 2);
const TEMP = args.temp === 'none' ? undefined : +(args.temp ?? 1);
const EXPS = String(args.exp || 'A,B,C').split(',').map((s) => s.trim().toUpperCase());
const LINE_TOL = 2;

// real kimi-k2.7 pricing ($/1M tokens)
const PRICE = { in: 0.95, cached: 0.16, out: 4.0 };

// --dataset=github-cases-v2 → one case per PR, `rules` array + groundTruthAll
// (full GT for every rule on every case, built by build-cases-v2.js) so the
// batched run is FULLY scored — no unscored "other-rule" flags.
const DATASET = args.dataset || 'github-cases';
const cases = require('./' + DATASET);

// Normalize both dataset shapes into per-case scoring targets:
// [{uuid, sites, violFiles, okFiles}] — one per rule with GT on that case.
function caseTargets(c) {
    const changed = c.realChangedFiles.map((f) => normalizePath(f.filename));
    if (c.groundTruthAll) {
        return (c.rules || []).map((r) => {
            const gt = c.groundTruthAll[r.uuid] || {};
            const violFiles = Object.keys(gt).map(normalizePath);
            const sites = Object.entries(gt).flatMap(([fn, hits]) =>
                hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
            return { uuid: r.uuid, sites, violFiles, okFiles: changed.filter((f) => !violFiles.includes(f)) };
        });
    }
    const gt = c.groundTruth || {};
    const violFiles = (c.violatingFiles || []).map(normalizePath);
    const sites = Object.entries(gt).flatMap(([fn, hits]) =>
        hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
    return [{ uuid: c.rule.uuid, sites, violFiles, okFiles: (c.cleanFiles || []).map(normalizePath) }];
}
function caseRules(c) { return c.rules || uniqueRulesFallback(); }
function uniqueRulesFallback() { return Object.values(Object.fromEntries(cases.map((c) => [c.rule.uuid, c.rule]))); }
function normalizePath(v) { return String(v || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/'); }
const isTestFile = (f) => /\.(spec|test)\.|__tests__|\/tests?\//i.test(f);


function parseJSON(text) {
    if (!text) return null;
    const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
    let o = tryP(text.trim());
    if (!o) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) o = tryP(m[1].trim()); }
    if (!o) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b > a) o = tryP(text.slice(a, b + 1)); }
    return o;
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
    }));
    return out;
}

// ── prompts ──────────────────────────────────────────────────────────────────
const SYSTEM_BATCHED = `You check a set of team rules against the diff of a SINGLE file. Report EVERY added line that violates ANY of the listed rules — one entry per (rule, violating line).

Rules of engagement:
- Only flag lines ADDED in this diff (prefixed with their file line number then '+'). Unchanged context lines are NEVER flagged.
- One entry PER violating line PER rule; do not collapse repeats.
- Use the exact rule id from the list. Never invent a rule id.
- If nothing violates, return an empty list. Do not report issues unrelated to the listed rules.`;

function batchedPrompt(rules, file) {
    const parts = [`<Rules>`];
    for (const r of rules) {
        parts.push(`- id: ${r.uuid}\n  title: ${r.title}\n  description: ${r.rule}`);
    }
    parts.push(`</Rules>`, ``, `<File path="${file.filename}">`);
    parts.push(`Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`);
    parts.push('```diff', file.patchWithLinesStr || file.patch || '', '```', `</File>`, ``);
    parts.push(`Return ONLY JSON: {"violations":[{"rule":"<rule id>","line":<file line number>,"code":"<offending code>"}]}`);
    return parts.join('\n');
}

const SYSTEM_PR = `You evaluate ONE pull-request-level team rule against a PR's metadata (title + list of changed files). Answer strictly from the provided list. Return ONLY JSON.`;

function prPrompt(rule, c) {
    const files = c.realChangedFiles.map((f) => f.filename);
    return [
        `<Rule>`, `Title: ${rule.title}`, `Description: ${rule.rule}`, `</Rule>`, ``,
        `<PR title="${(c.title || 'PR').replace(/"/g, "'")}">`,
        `Changed files (${files.length}):`,
        ...files.map((f) => `- ${f}`),
        `</PR>`, ``,
        `Return ONLY JSON: {"violated": true|false, "reason": "<one sentence>"}`,
    ].join('\n');
}

// Synthesized (but realistic) reference module for experiment C. The GT sites
// are still the REAL process.env lines in the real diffs — the reference only
// tests that inlined context doesn't derail the single-shot judge.
const REFERENCE_MODULE = `// src/shared/config/env.ts — typed config module (team convention)
import { z } from 'zod';

const EnvSchema = z.object({
    LANGSMITH_ENDPOINT: z.string().url().optional(),
    LANGSMITH_API_KEY: z.string().min(1).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

// Parsed once at boot; import { env } everywhere instead of process.env.
export const env = EnvSchema.parse(process.env);

// CORRECT:   import { env } from 'src/shared/config/env'; env.LANGSMITH_API_KEY
// INCORRECT: process.env.LANGSMITH_API_KEY`;

const SYSTEM_REF = `You check a SINGLE team rule against the diff of a SINGLE file. The rule references a shared module whose content is provided. Report EVERY added line that violates the rule — one entry per violating line.

Rules of engagement:
- Only flag lines ADDED in this diff (prefixed with file line number then '+').
- One entry per violating line; do not collapse repeats.
- If nothing violates, return an empty list.`;

function refPrompt(rule, file) {
    return [
        `<Rule>`, `Title: ${rule.title}`,
        `Description: Application code must not read process.env directly. All configuration must go through the shared typed config module (reference below).`,
        `</Rule>`, ``,
        `<ReferenceFile path="src/shared/config/env.ts">`, '```ts', REFERENCE_MODULE, '```', `</ReferenceFile>`, ``,
        `<File path="${file.filename}">`,
        `Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`,
        '```diff', file.patchWithLinesStr || file.patch || '', '```', `</File>`, ``,
        `Return ONLY JSON: {"violations":[{"line":<file line number>,"code":"<offending code>"}]}`,
    ].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    const tok = { in: 0, cached: 0, out: 0, calls: 0, errored: 0 };
    async function call(system, prompt) {
        tok.calls++;
        const res = await generateText({ model, system, prompt, ...(TEMP === undefined ? {} : { temperature: TEMP }) });
        const u = res.usage || {};
        const cached = u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0;
        tok.in += (u.inputTokens ?? 0) - cached;
        tok.cached += cached;
        tok.out += u.outputTokens ?? 0;
        return res.text;
    }
    const costOf = (t) => (t.in * PRICE.in + t.cached * PRICE.cached + t.out * PRICE.out) / 1e6;
    const snap = () => ({ ...tok });
    const delta = (a, b) => ({ in: b.in - a.in, cached: b.cached - a.cached, out: b.out - a.out, calls: b.calls - a.calls });
    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');

    // ── A) BATCHED multi-rule per file ──────────────────────────────────────
    // With a v2 dataset every rule has GT on every case, so EVERY flag is
    // scored (recall + precision + per-pair specificity) — no unscored bucket.
    if (EXPS.includes('A')) {
        const nRules = caseRules(cases[0]).length;
        console.log(`\n──── A) BATCHED: one call per file, ALL ${nRules} rules per call [dataset=${DATASET}] ────`);
        const t0 = snap();
        let occT = 0, occC = 0, fileT = 0, fileC = 0, cleanPairs = 0, falseAlarm = 0, offLine = 0, flagsTot = 0, unknownRule = 0;
        const perRule = {}; // uuid → {sites, caught, flags, offLine}
        for (const c of cases) {
            const rules = caseRules(c);
            const targets = caseTargets(c);
            const flagsNested = await mapLimit(c.realChangedFiles, CONC, async (f) => {
                try {
                    const o = parseJSON(await call(SYSTEM_BATCHED, batchedPrompt(rules, f)));
                    return (o && Array.isArray(o.violations) ? o.violations : [])
                        .map((v) => ({ rule: String(v.rule || ''), file: normalizePath(f.filename), line: Number(v.line) }))
                        .filter((v) => Number.isFinite(v.line));
                } catch (e) { tok.errored++; console.error(`  [${c.caseId} ${f.filename}] ${String(e.message).slice(0, 100)}`); return []; }
            });
            const all = flagsNested.flat();
            const knownUuids = new Set(rules.map((r) => r.uuid));
            unknownRule += all.filter((v) => !knownUuids.has(v.rule)).length;
            let caseSites = 0, caseCaught = 0, caseFlags = 0;
            for (const t of targets) {
                const flags = all.filter((v) => v.rule === t.uuid);
                const pr = (perRule[t.uuid] ||= { sites: 0, caught: 0, flags: 0, offLine: 0 });
                const flaggedFiles = new Set(flags.map((x) => x.file));
                fileT += t.violFiles.length; fileC += t.violFiles.filter((f) => flaggedFiles.has(f)).length;
                cleanPairs += t.okFiles.length; falseAlarm += t.okFiles.filter((f) => flaggedFiles.has(f)).length;
                occT += t.sites.length; pr.sites += t.sites.length;
                const covered = t.sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
                occC += covered; pr.caught += covered;
                const onTarget = flags.filter((x) => t.sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
                offLine += flags.length - onTarget; flagsTot += flags.length;
                pr.flags += flags.length; pr.offLine += flags.length - onTarget;
                caseSites += t.sites.length; caseCaught += covered; caseFlags += flags.length;
            }
            console.log(`${(c.caseId || c.rule.uuid).padEnd(34)} files=${c.realChangedFiles.length} sites=${caseSites}  caught=${caseCaught}  flags=${caseFlags}`);
        }
        const d = delta(t0, snap());
        console.log(`A/ FILE recall:   ${pct(fileC, fileT)}%  (${fileC}/${fileT} violating file×rule pairs)`);
        console.log(`A/ OCC recall:    ${pct(occC, occT)}%  (${occC}/${occT} sites, ALL rules scored)`);
        console.log(`A/ line precision:${pct(flagsTot - offLine, flagsTot)}%  (${offLine}/${flagsTot} off-site)`);
        console.log(`A/ pair specificity: ${pct(cleanPairs - falseAlarm, cleanPairs)}%  (${falseAlarm}/${cleanPairs} clean file×rule pairs false-alarmed)`);
        if (unknownRule) console.log(`A/ flags with invented rule id (dropped): ${unknownRule}`);
        console.log(`A/ per-rule: ${Object.entries(perRule).filter(([, v]) => v.sites || v.flags).map(([u, v]) => `${u}=${v.caught}/${v.sites}${v.flags - v.caught > 0 ? `(+${v.flags - v.caught}fp)` : ''}`).join('  ')}`);
        console.log(`A/ TOKENS fresh=${d.in} cached=${d.cached} out=${d.out} calls=${d.calls}  COST=$${costOf(d).toFixed(4)} (${nRules} rules judged per call)`);
    }

    // B/C/D/E consume the v1 per-(PR,rule) shape (c.rule / groundTruth).
    const isV2 = !!cases[0].groundTruthAll;
    if (isV2 && ['B', 'C', 'D', 'E'].some((x) => EXPS.includes(x))) {
        console.log(`\n(B/C/D/E skipped — they use the v1 dataset shape; run them without --dataset)`);
    }

    // ── B) PR-level rule (whole-PR shard) ───────────────────────────────────
    if (EXPS.includes('B') && !isV2) {
        console.log(`\n──── B) PR-LEVEL: "PR changing source must include a test change" — 1 call/PR ────`);
        const prRule = {
            uuid: 'pr-must-include-tests',
            title: 'Source changes require test changes',
            rule: 'Any pull request that modifies source code files must also include a change to at least one test file (*.spec.*, *.test.*, __tests__/, or a /test(s)/ directory). Documentation-only or config-only PRs are exempt.',
        };
        const t0 = snap();
        let correct = 0, tp = 0, fp = 0, fn = 0;
        const results = await mapLimit(cases, CONC, async (c) => {
            const gtViolated = !c.realChangedFiles.map((f) => f.filename).some(isTestFile);
            try {
                const o = parseJSON(await call(SYSTEM_PR, prPrompt(prRule, c)));
                return { gt: gtViolated, got: !!(o && o.violated) };
            } catch (e) { tok.errored++; return { gt: gtViolated, got: null }; }
        });
        for (const r of results) {
            if (r.got === null) continue;
            if (r.got === r.gt) correct++;
            if (r.got && r.gt) tp++;
            if (r.got && !r.gt) fp++;
            if (!r.got && r.gt) fn++;
        }
        const d = delta(t0, snap());
        console.log(`B/ accuracy: ${correct}/${results.length}   violations caught: ${tp}/${tp + fn}   false accusations: ${fp}`);
        console.log(`B/ TOKENS fresh=${d.in} cached=${d.cached} out=${d.out} calls=${d.calls}  COST=$${costOf(d).toFixed(4)}`);
    }

    // ── C) REFERENCE-FILE rule (inlined reference, still no tools) ──────────
    if (EXPS.includes('C') && !isV2) {
        console.log(`\n──── C) REFERENCE: process-env rule citing an inlined reference module ────`);
        const refCases = cases.filter((c) => c.rule.uuid === 'no-direct-process-env');
        const t0 = snap();
        let occT = 0, occC = 0, clean = 0, falseAlarm = 0;
        for (const c of refCases) {
            const okFiles = (c.cleanFiles || []).map(normalizePath);
            const sites = Object.entries(c.groundTruth || {})
                .flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
            const flagsNested = await mapLimit(c.realChangedFiles, CONC, async (f) => {
                try {
                    const o = parseJSON(await call(SYSTEM_REF, refPrompt(c.rule, f)));
                    return (o && Array.isArray(o.violations) ? o.violations : [])
                        .map((v) => ({ file: normalizePath(f.filename), line: Number(v.line) }))
                        .filter((v) => Number.isFinite(v.line));
                } catch (e) { tok.errored++; return []; }
            });
            const flags = flagsNested.flat();
            occT += sites.length;
            occC += sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            const flaggedFiles = new Set(flags.map((x) => x.file));
            clean += okFiles.length; falseAlarm += okFiles.filter((f) => flaggedFiles.has(f)).length;
        }
        const d = delta(t0, snap());
        console.log(`C/ OCC recall (with reference inlined): ${pct(occC, occT)}%  (${occC}/${occT})   [v1 without reference: 8/8]`);
        console.log(`C/ specificity: ${pct(clean - falseAlarm, clean)}%  (${falseAlarm}/${clean})`);
        console.log(`C/ TOKENS fresh=${d.in} cached=${d.cached} out=${d.out} calls=${d.calls}  COST=$${costOf(d).toFixed(4)}`);
    }

    // ── D) PR-LEVEL diff-dependent, LAZY: file list + readDiff tool ─────────
    // The proposal under test: keep enumeration deterministic (full file list
    // in the prompt) but let the model lazily read only the diffs it needs.
    // Risk to rule out: the measured agentic failure was "decides NOT to open
    // files" — so we track how many diffs it reads on the big PRs and whether
    // it still finds the violating files.
    if ((EXPS.includes('D') || EXPS.includes('E')) && !isV2) {
        const { tool, stepCountIs } = require('ai');
        const { z } = require('zod');
        const SYSTEM_D = `You judge ONE team rule at the PULL REQUEST level. You get the full list of changed files and a readDiff tool. Read the diffs you need (you may read many), then answer which files violate the rule. Only count violations on lines ADDED by this PR ('+'-prefixed with a file line number). Finish with ONLY JSON.`;

        async function runPrDiffJudge(c, lazy) {
            const files = c.realChangedFiles;
            const diffByName = new Map(files.map((f) => [normalizePath(f.filename), f.patchWithLinesStr || f.patch || '']));
            let reads = 0;
            const prompt = [
                `<Rule>`, `Title: ${c.rule.title}`, `Description: ${c.rule.rule}`, `</Rule>`, ``,
                `<PR title="${(c.title || 'PR').replace(/"/g, "'")}">`,
                `Changed files (${files.length}):`,
                ...files.map((f) => `- ${f.filename}`),
                `</PR>`, ``,
                ...(lazy ? [`Use readDiff to inspect files before judging. Do not guess from filenames alone.`] : [
                    `<Diffs>`,
                    ...files.map((f) => `### ${f.filename}\n\`\`\`diff\n${f.patchWithLinesStr || f.patch || ''}\n\`\`\``),
                    `</Diffs>`, ``,
                ]),
                `Return ONLY JSON: {"violatingFiles": ["path1", ...]}  (empty array if the PR complies)`,
            ].join('\n');
            tok.calls++;
            const res = await generateText({
                model, system: SYSTEM_D, prompt,
                ...(TEMP === undefined ? {} : { temperature: TEMP }),
                ...(lazy ? {
                    tools: {
                        readDiff: tool({
                            description: 'Read the diff of one changed file from this PR',
                            inputSchema: z.object({ filename: z.string() }),
                            execute: async ({ filename }) => { reads++; return diffByName.get(normalizePath(filename)) ?? 'File not found in this PR.'; },
                        }),
                    },
                    stopWhen: stepCountIs(40),
                } : {}),
            });
            const u = res.usage || {};
            const cached = u.cachedInputTokens ?? u.inputTokenDetails?.cacheReadTokens ?? 0;
            tok.in += (u.inputTokens ?? 0) - cached; tok.cached += cached; tok.out += u.outputTokens ?? 0;
            const o = parseJSON(res.text) || {};
            const got = new Set((Array.isArray(o.violatingFiles) ? o.violatingFiles : []).map(normalizePath));
            return { got, reads };
        }

        for (const variant of ['E', 'D']) {
            if (!EXPS.includes(variant)) continue;
            const lazy = variant === 'D';
            console.log(`\n──── ${variant}) PR-LEVEL diff-dependent — ${lazy ? 'LAZY: file list + readDiff tool' : 'CONTROL: all diffs inline'} ────`);
            const t0 = snap();
            let fT = 0, fC = 0, fFP = 0, readsTot = 0;
            for (const c of cases) {
                const viol = (c.violatingFiles || []).map(normalizePath);
                const okFiles = new Set((c.cleanFiles || []).map(normalizePath));
                try {
                    const { got, reads } = await runPrDiffJudge(c, lazy);
                    readsTot += reads;
                    const caught = viol.filter((f) => got.has(f)).length;
                    const fp = [...got].filter((f) => okFiles.has(f)).length;
                    fT += viol.length; fC += caught; fFP += fp;
                    console.log(`${c.rule.uuid.padEnd(22)} files=${c.realChangedFiles.length} viol=${viol.length} caught=${caught} falsePos=${fp}${lazy ? ` diffsRead=${reads}/${c.realChangedFiles.length}` : ''}`);
                } catch (e) { tok.errored++; console.error(`  [${c.rule.uuid}] ${String(e.message).slice(0, 120)}`); }
            }
            const d = delta(t0, snap());
            console.log(`${variant}/ violating-file recall: ${pct(fC, fT)}%  (${fC}/${fT})   false positives on clean files: ${fFP}`);
            if (lazy) console.log(`${variant}/ diffs read: ${readsTot} of ${cases.reduce((a, c) => a + c.realChangedFiles.length, 0)} files total`);
            console.log(`${variant}/ TOKENS fresh=${d.in} cached=${d.cached} out=${d.out} calls=${d.calls}  COST=$${costOf(d).toFixed(4)}`);
        }
    }

    console.log(`\n════ TOTAL (${MODELKEY}) ════`);
    console.log(`calls=${tok.calls} errored=${tok.errored}  fresh=${tok.in} cached=${tok.cached} out=${tok.out}`);
    console.log(`COST=$${costOf(tok).toFixed(4)}   [agentic baseline, same 14 PRs, 1 rule/session: $0.331 at 58% occ-recall]`);
}

main().catch((e) => { console.error(e); process.exit(2); });
