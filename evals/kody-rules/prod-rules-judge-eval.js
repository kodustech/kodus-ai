// Semantic-judge eval on REAL prod kody-rules (issue #1449).
//
// Real client rules are mostly SEMANTIC (judgment, not pattern). We had no way
// to test detection on them because there were no labeled violation sites. But
// almost every rule ships author-written `examples` with `isCorrect: true|false`
// — that IS ground truth by construction: the `incorrect` snippet must be
// flagged, the `correct` snippet must not. This eval runs the T1 single-shot
// judge over those examples and scores it.
//
//   node evals/kody-rules/prod-rules-judge-eval.js [--model=kimi-k2.7-code] [--temp=1] [--conc=2] [--limit=N] [--dataset=prod-rules]
//
// Input: evals/kody-rules/prod-rules.json — the BigQuery export (array of rule
// objects with at least {title, rule, examples:[{isCorrect, snippet}], type}).
//
// What this measures (the T1 question — "does THIS code violate THIS rule?"),
// NOT coverage across a big PR (already measured separately). Snippets are tiny
// and isolated, so this is a clean judgment test, not an end-to-end one.
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
const DATASET = args.dataset || 'prod-rules';

const allRules = require('./' + DATASET + '.json');

// Build labeled snippet cases from author examples. Only STANDARD rules with at
// least one incorrect AND one correct example are usable — a rule with only one
// side can't distinguish recall from false-positive. Memory rules are skipped:
// they are context/suppression, not detectors (type is a given field).
function buildCases(rules) {
    const cases = [];
    for (const r of rules) {
        if (r.type === 'memory') continue;
        if (r.status && r.status === 'deleted') continue; // skip retired rules
        const ex = Array.isArray(r.examples) ? r.examples : [];
        const bad = ex.filter((e) => e && e.isCorrect === false && e.snippet && e.snippet.trim());
        const good = ex.filter((e) => e && e.isCorrect === true && e.snippet && e.snippet.trim());
        if (!bad.length || !good.length) continue; // need both sides for a clean test
        const rule = { uuid: r.uuid, title: r.title, rule: r.rule, scope: r.scope };
        for (const e of bad) cases.push({ rule, snippet: e.snippet, expectViolation: true });
        for (const e of good) cases.push({ rule, snippet: e.snippet, expectViolation: false });
    }
    return cases;
}

const SYSTEM = `You check ONE team rule against ONE small code snippet. Decide whether the snippet VIOLATES the rule.

- Judge only against the rule described. Do not invent other issues.
- A snippet that follows the rule (or is unrelated to it) does NOT violate.
- Return ONLY JSON: {"violates": true|false, "reason": "<one sentence>"}`;

function prompt(rule, snippet) {
    return [
        `<Rule>`, `Title: ${rule.title}`, `Description: ${rule.rule}`, `</Rule>`, ``,
        `<Snippet>`, '```', snippet, '```', `</Snippet>`, ``,
        `Does the snippet violate the rule? Return ONLY the JSON.`,
    ].join('\n');
}

function parseJSON(text) {
    const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
    if (!text) return null;
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

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let cases = buildCases(allRules);
    if (args.limit) cases = cases.slice(0, +args.limit);
    const usableRules = new Set(cases.map((c) => c.rule.uuid)).size;
    console.log(`Rules in dataset: ${allRules.length}  |  usable (standard, both-example): ${usableRules}  |  snippet cases: ${cases.length}`);

    let net = 0;
    const results = await mapLimit(cases, CONC, async (c) => {
        try {
            const res = await generateText({ model, system: SYSTEM, prompt: prompt(c.rule, c.snippet), ...(TEMP === undefined ? {} : { temperature: TEMP }) });
            const o = parseJSON(res.text);
            return { ...c, got: o ? !!o.violates : null };
        } catch (e) { net++; return { ...c, got: null, net: true }; }
    });

    const scored = results.filter((r) => r.got !== null);
    const badCases = scored.filter((r) => r.expectViolation);
    const goodCases = scored.filter((r) => !r.expectViolation);
    const tp = badCases.filter((r) => r.got === true).length;   // correctly flagged violations
    const fnMiss = badCases.length - tp;                          // missed violations
    const fp = goodCases.filter((r) => r.got === true).length;   // false alarms on clean snippets
    const tn = goodCases.length - fp;

    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    // per-rule: a rule "passes" if ALL its incorrect examples flag and NO correct example flags
    const byRule = {};
    for (const r of scored) {
        const k = r.rule.uuid;
        (byRule[k] ||= { title: r.rule.title, badTot: 0, badHit: 0, goodTot: 0, goodFp: 0 });
        if (r.expectViolation) { byRule[k].badTot++; if (r.got) byRule[k].badHit++; }
        else { byRule[k].goodTot++; if (r.got) byRule[k].goodFp++; }
    }
    const rulesClean = Object.values(byRule).filter((v) => v.badHit === v.badTot && v.goodFp === 0).length;

    console.log(`\n════ SEMANTIC JUDGE on real prod rule examples (${MODELKEY}) ════`);
    console.log(`violation recall:   ${pct(tp, badCases.length)}%  (${tp}/${badCases.length} incorrect-examples flagged)`);
    console.log(`false-positive rate:${pct(fp, goodCases.length)}%  (${fp}/${goodCases.length} correct-examples wrongly flagged)`);
    console.log(`specificity:        ${pct(tn, goodCases.length)}%  (${tn}/${goodCases.length} correct-examples correctly passed)`);
    console.log(`per-rule fully-correct: ${pct(rulesClean, Object.keys(byRule).length)}%  (${rulesClean}/${Object.keys(byRule).length} rules: all incorrect flagged AND no correct flagged)`);
    if (net) console.log(`⚠ network errors: ${net} cases skipped — rerun to fill`);

    // surface the worst offenders for inspection
    const misses = badCases.filter((r) => !r.got).map((r) => `MISS  ${r.rule.title}`);
    const falseAlarms = goodCases.filter((r) => r.got).map((r) => `FP    ${r.rule.title}`);
    if (misses.length) console.log(`\nMissed violations (${misses.length}):\n  ` + [...new Set(misses)].slice(0, 25).join('\n  '));
    if (falseAlarms.length) console.log(`\nFalse alarms (${falseAlarms.length}):\n  ` + [...new Set(falseAlarms)].slice(0, 25).join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(2); });
