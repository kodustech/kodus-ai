// Feasibility check: how many of the 27 (sanitized) client rules compile into
// T0 regex detectors via the REAL shipped compiler (makeLLMRunCompiler +
// compileRuleDetector, including its example-based gate)? Compiled detectors
// are then EXECUTED over the 3 analog PR diffs and scored against
// groundTruthAll — so the answer is "would compile AND actually catches the
// known violations", not just "the LLM said mechanical".
//
//   node evals/kody-rules/physitrack-detector-feasibility.js [--model=gpt-5.4-mini]
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
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const MODELKEY = args.model || 'gpt-5.4-mini';

const cases = require('./rails-convention-cases-all.json');
const rules = cases[cases.length - 1].rules; // all 27 (same set in every case)

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    applyModelEnv(MODELKEY);
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');
    const {
        compileRuleDetector,
        makeLLMRunCompiler,
    } = require('../../libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.ts');

    // Contract: the closure must return PARSED CompilerOutput (not raw text) —
    // mirrors how the shipped service feeds runStructuredReviewCall's output.
    const parseJSON = (text) => {
        const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
        if (!text) return null;
        let o = tryP(text.trim());
        if (!o) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) o = tryP(m[1].trim()); }
        if (!o) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b > a) o = tryP(text.slice(a, b + 1)); }
        return o;
    };
    const runCompiler = makeLLMRunCompiler(async ({ system, user }) => {
        const res = await generateText({ model, system, prompt: user, temperature: 0 });
        return parseJSON(res.text);
    });

    // added lines of every case: caseId → [{file, line, code}]
    const added = cases.map((c) => ({
        caseId: c.caseId,
        gt: c.groundTruthAll || {},
        lines: c.realChangedFiles.flatMap((f) =>
            String(f.patchWithLinesStr || '').split('\n').flatMap((ln) => {
                const m = ln.match(/^\s*(\d+)\s*\+(.*)$/);
                return m ? [{ file: f.filename, line: +m[1], code: m[2] }] : [];
            }),
        ),
    }));

    let compiled = 0, declined = 0, gateFailed = 0;
    const rows = [];
    for (const r of rules) {
        let out;
        try {
            out = await compileRuleDetector(r, runCompiler);
        } catch (e) {
            rows.push({ title: r.title, verdict: `ERROR: ${String(e.message).slice(0, 60)}` });
            continue;
        }
        if (!out.detector) {
            declined++;
            const gate = /gate/i.test(out.declineReason || '') ? (gateFailed++, ' [gate]') : '';
            rows.push({ title: r.title, verdict: `declined (${out.declineReason})${gate}` });
            continue;
        }
        compiled++;
        // execute over the analog diffs vs this rule's GT
        const rx = new RegExp(out.detector.pattern, out.detector.flags || '');
        let gtTotal = 0, gtHit = 0, extra = 0;
        for (const c of added) {
            const gtSites = new Set(
                Object.entries(c.gt[r.uuid] || {}).flatMap(([fn, hs]) => hs.map((h) => `${fn}:${h.line}`)),
            );
            const hits = new Set(
                c.lines.filter((l) => { rx.lastIndex = 0; return rx.test(l.code); }).map((l) => `${l.file}:${l.line}`),
            );
            gtTotal += gtSites.size;
            for (const s of gtSites) if (hits.has(s)) gtHit++;
            for (const h of hits) if (!gtSites.has(h)) extra++;
        }
        rows.push({
            title: r.title,
            verdict: `COMPILED  /${out.detector.pattern.slice(0, 60)}/  GT ${gtHit}/${gtTotal}${extra ? `  extra-flags=${extra}` : ''}`,
        });
    }

    console.log(`\n════ detector feasibility — ${rules.length} client rules (${MODELKEY}) ════`);
    for (const row of rows) console.log(`  ${row.verdict.padEnd(90).slice(0, 110)}  ← ${row.title.slice(0, 60)}`);
    console.log(`\ncompiled: ${compiled}/${rules.length} · declined: ${declined} (gate-failed among them: ${gateFailed})`);
}
main().catch((e) => { console.error(e); process.exit(2); });
