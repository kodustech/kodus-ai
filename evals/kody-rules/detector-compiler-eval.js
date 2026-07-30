// T0 detector-compiler eval (issue #1449, tier-0 design).
//
// The riskiest link of T0 is the COMPILER: one LLM call that reads a
// natural-language kody rule and either emits a deterministic detector
// (regex over added lines) or declines ("not mechanical" → rule stays on the
// LLM path). This eval measures that link BEHAVIORALLY:
//
//   - 11 mechanical rules (from github-cases-v2): the model sees ONLY the
//     rule title+text (never our reference regex). Whatever regex it emits is
//     EXECUTED over the frozen v2 diffs and scored against groundTruthAll —
//     equivalent regexes pass, broken ones fail. No string-matching of regexes.
//   - 6 semantic rules: the correct output is to DECLINE. Compiling a
//     semantic rule into a bad regex is the worst failure mode (phantom
//     recall), so refusal accuracy is scored strictly.
//   - 2 ambiguous rules: reported informationally, not scored.
//
//   node evals/kody-rules/detector-compiler-eval.js [--model=gpt-5.4-mini] [--temp=0]
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
const MODELKEY = args.model || 'gpt-5.4-mini';
const TEMP = args.temp === 'none' ? undefined : +(args.temp ?? 0);

const cases = require('./github-cases-v2.json');
const mechanicalRules = cases[0].rules; // 11 rules — title+rule text only is shown to the model

// Semantic rules the compiler MUST decline (compiling these into a regex is
// the phantom-recall failure mode).
const semanticRules = [
    { uuid: 'sem-actionable-errors', title: 'Error messages must be actionable', rule: 'Error messages shown to users must be actionable: say what went wrong AND what the user can do next.' },
    { uuid: 'sem-endpoint-naming', title: 'Endpoints follow router conventions', rule: 'New public API endpoints must follow the naming and versioning conventions already used by the existing router modules.' },
    { uuid: 'sem-batch-queries', title: 'Batch queries in growing loops', rule: 'Database queries inside loops should be batched or moved out of the loop when the loop size can grow with user data.' },
    { uuid: 'sem-error-pattern-ref', title: 'Follow shared error pattern', rule: 'Follow the error-handling pattern established in src/shared/errors.ts when adding new error types.' },
    { uuid: 'sem-a11y-keyboard', title: 'Interactive elements need keyboard support', rule: 'Components must be accessible: interactive elements (clickable divs, custom buttons) need keyboard handlers and focus management.' },
    { uuid: 'sem-billing-tests', title: 'Billing changes need proration tests', rule: 'PRs that change billing logic must include a test covering the proration path.' },
];

// Ambiguous (partially mechanical) — reported, NOT scored.
const ambiguousRules = [
    { uuid: 'amb-sync-fs', title: 'No sync fs in request handlers', rule: 'Do not use synchronous fs methods (fs.readFileSync, fs.writeFileSync, etc.) inside request handlers.' },
    { uuid: 'amb-then-chains', title: 'Prefer async/await', rule: 'Prefer async/await over .then() promise chains in new code.' },
];

const SYSTEM = `You compile a team code-review rule into a deterministic detector, or decline.

A rule is MECHANICAL only if a single-line regular expression over the ADDED lines of a diff can detect every violation with high precision — no surrounding context, no cross-line or cross-file reasoning, no judgment about intent, naming quality, or whether something "should" exist elsewhere.

INPUT CONTRACT (critical): your regex is applied by the engine to the raw CONTENT of ONE added line of source code — the code text ONLY. The engine has already stripped every diff marker: there is NO leading '+', NO line number, NO '@@' hunk header. So:
- Match the code itself (e.g. \`console\\.(log|warn|error)\\s*\\(\`).
- NEVER anchor to a '+' or a line-number prefix (e.g. do NOT write \`^\\+\` or \`^\\s*\\d+\`). Those never match — the engine feeds pure code.
- Assume single-line matching; you cannot see other lines.

If mechanical, emit a JavaScript-compatible regex (source only, no slashes) that matches a violating line of code CONTENT.
If not mechanical, decline — a wrong regex silently hides violations, which is worse than routing the rule to the LLM reviewer.

Return ONLY JSON:
  {"mechanical": true, "pattern": "<regex source>", "flags": "<optional, e.g. i>", "reason": "<one sentence>"}
or
  {"mechanical": false, "reason": "<one sentence>"}`;

function rulePrompt(r) {
    return `<Rule>\nTitle: ${r.title}\nDescription: ${r.rule}\n</Rule>\n\nCompile this rule or decline. Return ONLY the JSON.`;
}

function parseJSON(text) {
    const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
    if (!text) return null;
    let o = tryP(text.trim());
    if (!o) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) o = tryP(m[1].trim()); }
    if (!o) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b > a) o = tryP(text.slice(a, b + 1)); }
    return o;
}

// Execute a detector over every case's added lines → set of "file:line" sites.
function runDetector(rx) {
    const hits = new Map(); // caseId → Set("file:line")
    for (const c of cases) {
        const set = new Set();
        for (const f of c.realChangedFiles) {
            for (const ln of String(f.patchWithLinesStr || '').split('\n')) {
                const m = ln.match(/^\s*(\d+)\s*\+(.*)$/);
                if (m && rx.test(m[2])) set.add(`${f.filename}:${m[1]}`);
            }
        }
        hits.set(c.caseId, set);
    }
    return hits;
}

function gtSites(uuid) {
    const sites = new Map();
    for (const c of cases) {
        const gt = (c.groundTruthAll || {})[uuid] || {};
        const set = new Set();
        for (const [fn, hs] of Object.entries(gt)) for (const h of hs) set.add(`${fn}:${h.line}`);
        sites.set(c.caseId, set);
    }
    return sites;
}

// DigitalOcean-hosted models (not in the tier0 registry) — wire the env the
// self-hosted byokToVercelModel path reads, same as real-agent.js.
const DO_MODELS = {
    'deepseek-4-flash': 'deepseek-4-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro',
    'deepseek-3.2': 'deepseek-3.2',
};

async function main() {
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    if (TIER0[MODELKEY]) {
        applyModelEnv(MODELKEY);
    } else if (DO_MODELS[MODELKEY]) {
        const key = process.env.DO_MODEL_ACCESS_KEY;
        if (!key) throw new Error('no DO_MODEL_ACCESS_KEY for a DO model');
        process.env.API_LLM_PROVIDER_MODEL = DO_MODELS[MODELKEY];
        process.env.API_OPEN_AI_API_KEY = key;
        process.env.API_OPENAI_FORCE_BASE_URL = 'https://inference.do-ai.run/v1';
    } else {
        throw new Error(`unknown model ${MODELKEY}`);
    }
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let netErrors = 0;
    async function compile(r) {
        // One flaky network call must not kill the whole eval — mark the rule
        // as NETWORK and keep going; rerun later fills the gaps.
        try {
            const res = await generateText({ model, system: SYSTEM, prompt: rulePrompt(r), ...(TEMP === undefined ? {} : { temperature: TEMP }) });
            return parseJSON(res.text);
        } catch (e) {
            netErrors++;
            console.log(`  ! ${r.uuid.padEnd(26)} NETWORK ERROR (${String(e.message).slice(0, 60)})`);
            return undefined; // distinguishable from a parsed decline
        }
    }

    console.log(`──── T0 detector-compiler eval (${MODELKEY}) ────\n`);

    // 1) mechanical rules: emitted regex must behaviorally reproduce the GT
    let compiled = 0, recallSum = 0, recallN = 0, totalGT = 0, totalCaught = 0, totalExtra = 0, refusedMech = 0, badRegex = 0;
    console.log(`[MECHANICAL — must compile + behaviorally match GT]`);
    for (const r of mechanicalRules) {
        const o = await compile(r);
        if (o === undefined) continue; // network — not a decline
        if (!o || o.mechanical !== true || !o.pattern) {
            refusedMech++;
            console.log(`  ✗ ${r.uuid.padEnd(26)} DECLINED (${(o && o.reason || 'no parse').slice(0, 70)})`);
            continue;
        }
        let rx;
        try { rx = new RegExp(o.pattern, o.flags || ''); } catch (e) {
            badRegex++;
            console.log(`  ✗ ${r.uuid.padEnd(26)} INVALID REGEX: ${String(o.pattern).slice(0, 60)}`);
            continue;
        }
        compiled++;
        const det = runDetector(rx);
        const gt = gtSites(r.uuid);
        let gtN = 0, caught = 0, extra = 0;
        for (const c of cases) {
            const g = gt.get(c.caseId), d = det.get(c.caseId);
            gtN += g.size;
            for (const s of g) if (d.has(s)) caught++;
            for (const s of d) if (!g.has(s)) extra++;
        }
        totalGT += gtN; totalCaught += caught; totalExtra += extra;
        if (gtN) { recallSum += caught / gtN; recallN++; }
        console.log(`  ${gtN && caught === gtN && !extra ? '✓' : gtN && caught / gtN >= 0.95 ? '~' : gtN ? '✗' : '·'} ${r.uuid.padEnd(26)} recall=${gtN ? `${caught}/${gtN}` : 'n/a (0 GT)'} extraMatches=${extra}  /${String(o.pattern).slice(0, 55)}/`);
    }

    // 2) semantic rules: must decline
    let refusedSem = 0;
    console.log(`\n[SEMANTIC — must DECLINE]`);
    let semSeen = 0;
    for (const r of semanticRules) {
        const o = await compile(r);
        if (o === undefined) continue; // network — no credit either way
        semSeen++;
        const declined = !o || o.mechanical === false;
        if (declined) refusedSem++;
        console.log(`  ${declined ? '✓ declined' : `✗ COMPILED /${String(o.pattern).slice(0, 50)}/`}  ${r.uuid.padEnd(24)} (${(o && o.reason || '').slice(0, 60)})`);
    }

    // 3) ambiguous: informational
    console.log(`\n[AMBIGUOUS — informational only]`);
    for (const r of ambiguousRules) {
        const o = await compile(r);
        console.log(`  ${r.uuid.padEnd(24)} → ${o && o.mechanical ? `compiled /${String(o.pattern).slice(0, 50)}/` : 'declined'} (${(o && o.reason || '').slice(0, 60)})`);
    }

    console.log(`\n════ SUMMARY (${MODELKEY}) ════`);
    console.log(`mechanical rules compiled: ${compiled}/${mechanicalRules.length}  (declined=${refusedMech}, invalid-regex=${badRegex})`);
    console.log(`behavioral site recall:    ${totalGT ? (100 * totalCaught / totalGT).toFixed(0) : '—'}%  (${totalCaught}/${totalGT} GT sites reproduced by emitted detectors)`);
    console.log(`extra matches (FP sites):  ${totalExtra}`);
    console.log(`semantic refusal accuracy: ${refusedSem}/${semSeen}${semSeen < semanticRules.length ? ` (${semanticRules.length - semSeen} skipped: network)` : ''}`);
    if (netErrors) console.log(`⚠ network errors: ${netErrors} rules skipped — rerun to fill gaps`);
}

main().catch((e) => { console.error(e); process.exit(2); });
