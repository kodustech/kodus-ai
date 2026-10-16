#!/usr/bin/env node
// format: drives the formatter the review stage calls, `formatSuggestionContent`
// (libs/code-review/infrastructure/agents/engine/format-suggestion-content.ts),
// on real findings (batches.json) under each production configuration
// (variants.js), and checks what it ships (checks.js).
//
//   node evals/format/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N]
//
// What ships is what the stage keeps: the formatted text, or the finder's own
// text when the formatter returned none for that finding. A provider refusal
// leaves the case unmeasured; a timeout or an unreadable answer ships the local
// fallback, as in production, and is scored.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { VARIANTS } = require('./variants');
const { failedChecks } = require('./checks');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const BATCHES = Object.fromEntries(require('./batches.json').map((b) => [b.id, b]));
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
applyModelEnv(MODEL);
countTokens();
const { formatSuggestionContent } = require('../../libs/code-review/infrastructure/agents/engine/format-suggestion-content.ts');
const { classifyLLMError, LlmErrorCategory } = require('../../libs/llm/error-classifier.ts');

// The scripted model answers nothing usable, so what ships is the local
// fallback, which only removes the labels: it owes the labels gone, the names
// kept and no code block, not a length or a language.
const FALLBACK_ONLY = MODEL === 'eval-fake' ? ['empty', 'labels', 'identifiers', 'no-code'] : null;

// Refusals the eval cannot score. A timeout is not one: production ships the
// local fallback after it, and so does the eval.
const REFUSED = new Set(['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED'].map((c) => LlmErrorCategory[c]));

async function runCase(c) {
    const batch = BATCHES[c.batch];
    const variant = VARIANTS[c.variant];
    const { result: formatted, errors } = await withCallErrors(() =>
        formatSuggestionContent(batch.findings, {
            languageResultPrompt: variant.languageResultPrompt,
            customWritingGuidelines: variant.customWritingGuidelines,
            organizationId: 'format-eval',
        }),
    );
    const refusal = errors.find((e) => REFUSED.has(classifyLLMError(e).category));
    if (refusal) throw new Error(`formatter call refused: ${String(refusal?.message || refusal).slice(0, 200)}`);
    const detail = batch.findings.map((f, i) => {
        const out = formatted.get(i)?.suggestionContent;
        const shipped = out && out.trim() ? out : f.suggestionContent;
        const failed = failedChecks(f, shipped, FALLBACK_ONLY ? { ...variant.want, only: FALLBACK_ONLY } : variant.want);
        return { what: `${i}. ${f.relevantFile}: ${f.title.slice(0, 70)}${failed.length ? ` — ${failed.join(', ')}` : ''}`, ok: !failed.length };
    });
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            const n = BATCHES[c.batch].findings.length;
            const [model, pr] = c.batch.split('/');
            // Named by its review: the panel lists every case, and two reviews
            // by the same model can carry the same number of findings.
            const checks = `Formats ${n} finding${n === 1 ? '' : 's'} ${model.replace(/@.*/, '')} wrote on ${pr}, ${VARIANTS[c.variant].checks}`;
            try {
                results[i] = { id: c.id, checks, ...(await runCase(c)) };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 8) }, worker));

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'format',
        question: evalQuestion('evals/format'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of findings formatted right', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    // One line per configuration, with how many findings failed each check.
    for (const variant of Object.keys(VARIANTS)) {
        const rows = results.filter((r, i) => cases[i].variant === variant);
        if (!rows.length) continue;
        const failed = {};
        for (const d of rows.flatMap((r) => r.detail || []).filter((x) => !x.ok)) {
            for (const check of d.what.split(' — ').pop().split(', ')) {
                const key = check.replace(/ \(.*/, '');
                failed[key] = (failed[key] || 0) + 1;
            }
        }
        const h = rows.reduce((n, r) => n + r.hits, 0);
        const t = rows.reduce((n, r) => n + r.total, 0);
        const why = Object.entries(failed).map(([k, v]) => `${k} ${v}`).join(', ');
        console.log(`  ${variant.padEnd(20)} ${h}/${t}${why ? `  failed: ${why}` : ''}`);
    }
    console.log(`format: ${hits}/${total} findings formatted right · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.error(`GATE NOT EVALUATED: no floor for ${MODEL} in evals/format/targets.json`);
        return 0;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/format/targets.json`);
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
