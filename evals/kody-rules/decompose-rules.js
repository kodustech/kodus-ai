// Phase-2 experiment: VIRTUAL ATOMIC DECOMPOSITION of long rules.
//
// For each rule >1000 chars, one LLM call decomposes it into <=12 atomic
// requirements (title + one-condition what/how spec + its own bad/good
// examples). Each atom then goes through the REAL shipped detector compiler
// (compileRuleDetector + its example gate): atoms that compile become T0
// regex detectors (zero LLM at review time); the rest stay semantic and are
// judged as individual numbered rules by the shard judge.
//
// Atoms are cached in .atoms-cache.json (keyed by rule uuid) so every
// runner rep/model reuses the same decomposition — mirrors the once-per-rule
// product design. Delete the cache to force regeneration.
//
// NOTE: eval harness — runs LOCALLY with env keys only (never customer
// BYOK, never in prod). Bare/stubbed LLM calls here are intentional; the
// PRODUCT path (KodyRuleSummaryService) is fully usage-span wrapped.
//   node evals/kody-rules/decompose-rules.js [--model=gpt-5.4-mini]
const fs = require('fs');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (m, f) {
    const { code } = esbuild.transformSync(fs.readFileSync(f, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: f,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    });
    m._compile(code, f);
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
const THRESHOLD = 1000;
const MAX_ATOMS = 12;
const CACHE = path.join(__dirname, '.atoms-cache.json');
const AUDIT = path.join(__dirname, '.atoms-audit.txt');

const DECOMPOSE_SYSTEM = `You decompose a long team code-review rule into ATOMIC requirements. Each atom is ONE independently-checkable condition a reviewer flags in a code diff.

Return ONLY JSON:
{"atoms":[{"title":"<short imperative label, <=80 chars>","spec":"WHAT: <the single condition to flag>\\nHOW: <what pattern/signal in the ADDED lines of a diff indicates this violation>","examples":[{"snippet":"<code violating THIS atom>","isCorrect":false},{"snippet":"<compliant version>","isCorrect":true}]}]}

Constraints:
- At most ${MAX_ATOMS} atoms. If the rule has more requirements, merge the closest ones — never drop an enforceable requirement silently.
- Each atom covers exactly ONE condition. No compound atoms ("X and also Y").
- Examples are SHORT (1-4 lines), concrete, in the rule's target language, and must violate/satisfy THIS atom specifically.
- English output. Do NOT invent requirements that are not in the rule.`;

// Position-guided repair for one failure mode observed at temp 0: Ruby
// interpolation (`#{...}`) inside example snippets makes the model emit the
// invalid JSON escape `\#`. On a bad-escape parse error, strip exactly the
// offending backslash and retry — never a blanket regex (which would corrupt
// legitimate `\\` sequences in regex-bearing snippets).
const parseRepair = (s) => {
    let t = s;
    for (let i = 0; i < 30; i++) {
        try { return JSON.parse(t); } catch (e) {
            if (!/escaped character/i.test(String(e.message))) return null;
            const m = /position (\d+)/.exec(String(e.message));
            if (!m) return null;
            const p = +m[1];
            if (t[p] === '\\') t = t.slice(0, p) + t.slice(p + 1);
            else if (t[p - 1] === '\\') t = t.slice(0, p - 1) + t.slice(p);
            else return null;
        }
    }
    return null;
};
const parseJSON = (text) => {
    const tryP = (s) => { try { return JSON.parse(s); } catch { return parseRepair(s); } };
    if (!text) return null;
    let o = tryP(text.trim());
    if (!o) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) o = tryP(m[1].trim()); }
    if (!o) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a !== -1 && b > a) o = tryP(text.slice(a, b + 1)); }
    return o;
};

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    applyModelEnv(MODELKEY);
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');
    const { compileRuleDetector, makeLLMRunCompiler } = require('../../libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler.ts');

    // Contract: the compiler closure returns PARSED CompilerOutput, not text.
    const runCompiler = makeLLMRunCompiler(async ({ system, user }) =>
        parseJSON((await generateText({ model, system, prompt: user, temperature: 0 })).text));

    const cases = require('./rails-convention-cases-all.json');
    const byUuid = new Map();
    for (const c of cases) for (const r of c.rules) if (!byUuid.has(r.uuid)) byUuid.set(r.uuid, r);

    const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
    let audit = '';
    let totalAtoms = 0, totalDetectors = 0, decomposed = 0;

    for (const [uuid, r] of byUuid) {
        if ((r.rule || '').length <= THRESHOLD) continue;
        if (cache[uuid]) { decomposed++; totalAtoms += cache[uuid].length; totalDetectors += cache[uuid].filter(a => a.detector).length; continue; }

        const res = await generateText({
            model, system: DECOMPOSE_SYSTEM,
            prompt: `Rule title: ${r.title}\n\nRule text:\n${r.rule}`,
            temperature: 0,
        });
        const parsed = parseJSON(res.text);
        if (!parsed?.atoms?.length) { console.log(`DECOMPOSE FAILED: ${r.title}`); continue; }
        const atoms = parsed.atoms.slice(0, MAX_ATOMS);

        // Try to compile each atom via the REAL shipped compiler + example gate.
        for (let i = 0; i < atoms.length; i++) {
            const a = atoms[i];
            a.id = `${uuid}-atom-${i + 1}`;
            try {
                const out = await compileRuleDetector(
                    { uuid: a.id, title: a.title, rule: a.spec, examples: a.examples },
                    runCompiler,
                );
                if (out.detector) a.detector = out.detector;
                else a.declineReason = out.declineReason;
            } catch (e) { a.declineReason = `compile error: ${String(e.message).slice(0, 60)}`; }
        }
        cache[uuid] = atoms;
        fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
        decomposed++;
        totalAtoms += atoms.length;
        const nDet = atoms.filter(a => a.detector).length;
        totalDetectors += nDet;
        console.log(`${r.title.slice(0, 55).padEnd(57)} atoms=${atoms.length}  T0=${nDet}`);
        audit += `\n═══ ${r.title} (${atoms.length} atoms, ${nDet} T0) ═══\n` +
            atoms.map(a => `  [${a.detector ? 'T0 ' : 'LLM'}] ${a.title}${a.detector ? `  /${a.detector.pattern.slice(0, 50)}/` : ''}`).join('\n') + '\n';
    }

    fs.writeFileSync(AUDIT, audit);
    console.log(`\nrules decomposed: ${decomposed} · atoms: ${totalAtoms} · T0 detectors: ${totalDetectors} (${totalAtoms ? (100 * totalDetectors / totalAtoms).toFixed(0) : 0}%)`);
    console.log(`cache: ${CACHE}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
