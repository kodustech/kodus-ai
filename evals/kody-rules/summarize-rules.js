// Experiment: structured rule summarization (user-directed, 2026-07-17).
// For rules whose text is >500 chars, replace the rule body with an LLM-generated
// structured extract — "WHAT TO VALIDATE" + "HOW TO VALIDATE" (English in/out).
// Examples stay as-is (deterministic, ruleBlock already renders them below the
// description). Short rules untouched. Output: a NEW dataset file; the original
// is never mutated. Summaries generated ONCE and reused across gpt/GLM phases.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (m, f) {
    const { code } = esbuild.transformSync(fs.readFileSync(f, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: f,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    });
    m._compile(code, f);
};
require('tsconfig-paths/register');
const dotenv = require('dotenv');
const ROOT = '/Users/juniorsartori/Projects/Kody/kodus-ai';
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const IN = path.join(ROOT, 'evals/kody-rules/rails-convention-cases-all.json');
const OUT = path.join(ROOT, 'evals/kody-rules/rails-convention-cases-summarized-v2.json');
const AUDIT = '/private/tmp/claude-501/-Users-juniorsartori-Projects-Kody-kodus-ai/f29e42c9-7526-423f-a336-6aca036ad54b/scratchpad/summaries-audit-v2.txt';
const THRESHOLD = 500;

// v2 (2026-07-20): adds WHEN NOT TO FLAG — rules carry explicit carve-outs
// ("editing existing legacy X is acceptable") that the two-section summary
// dropped, inflating false positives. Exceptions must come from the rule text
// only. v1 (two sections) kept in rails-convention-cases-summarized.json for A/B.
const SYSTEM = `You convert a long team code-review rule into a compact validation spec. Output EXACTLY three sections in English, plain text, nothing else:

WHAT TO VALIDATE:
- one bullet per concrete, checkable condition a reviewer must flag in a code diff (imperative, specific)

HOW TO VALIDATE:
- one bullet per condition: what pattern/signal in the ADDED lines of a diff indicates a violation

WHEN NOT TO FLAG:
- one bullet per exception, carve-out, or explicitly allowed case stated in the rule (e.g. "legacy code may be modified in place", "editing existing X is acceptable"). ONLY exceptions the rule itself states — if the rule states none, write "- (none stated)"

Keep EVERY enforceable requirement from the rule — do not drop rare or edge conditions. Do NOT invent requirements or exceptions that are not in the rule. Do not include examples (they are provided separately).`;

async function main() {
    const { applyModelEnv } = require(path.join(ROOT, 'evals/shared/tier0-models'));
    applyModelEnv('gpt-5.4-mini');
    const { buildEvalModel } = require(path.join(ROOT, 'evals/shared/build-model.js'));
    const model = buildEvalModel({});
    const { generateText } = require('ai');

    const cases = JSON.parse(fs.readFileSync(IN, 'utf8'));
    // Unique rules across cases (same 27 in each case) — summarize once per uuid.
    const byUuid = new Map();
    for (const c of cases) for (const r of c.rules) if (!byUuid.has(r.uuid)) byUuid.set(r.uuid, r);

    const summaries = new Map();
    let audit = '';
    for (const [uuid, r] of byUuid) {
        const len = (r.rule || '').length;
        if (len <= THRESHOLD) { audit += `SKIP (${len} chars) ${r.title}\n`; continue; }
        const res = await generateText({
            model,
            system: SYSTEM,
            prompt: `Rule title: ${r.title}\n\nRule text:\n${r.rule}`,
            temperature: 0,
        });
        const text = res.text.trim();
        if (!/WHAT TO VALIDATE/i.test(text) || !/HOW TO VALIDATE/i.test(text)) {
            throw new Error(`summary for ${r.title} missing required sections`);
        }
        summaries.set(uuid, text);
        audit += `\n═══ SUMMARIZED (${len} → ${text.length} chars) ${r.title} ═══\n${text}\n`;
        console.log(`summarized: ${r.title} (${len} → ${text.length} chars)`);
    }

    const out = cases.map((c) => ({
        ...c,
        rules: c.rules.map((r) =>
            summaries.has(r.uuid) ? { ...r, rule: summaries.get(r.uuid) } : r,
        ),
    }));
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    fs.writeFileSync(AUDIT, audit);
    console.log(`\nrules summarized: ${summaries.size}/${byUuid.size} · written: ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(2); });
