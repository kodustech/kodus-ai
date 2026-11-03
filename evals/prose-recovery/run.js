#!/usr/bin/env node
// prose-recovery: production's recoverFindingsFromProse (finder.agent.ts) over
// finder prose written for each case, on the model's production slot, the way
// evals/parse/run.js routes it. A case's findings are matched by file only.
//
//   node evals/prose-recovery/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N]
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { orgRouteOrExit, EVAL_ORG } = require('../shared/model-route');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const MODEL = args.model || 'eval-fake';
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);
const TARGET = require('./targets.json').models[MODEL] || {};

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
countTokens();
const { recoverFindingsFromProse } = require('../../libs/code-review/infrastructure/agents/core/finder.agent.ts');
const { routeCodeReviewModel } = require('../../libs/code-review/pipeline/stages/route-code-review-model.ts');
const { classifyLLMError, LlmErrorCategory } = require('../../libs/llm/error-classifier.ts');

// The prose recovery as production wires it (core-agent-loop.adapter.ts): the
// slot ValidateConfigStage routes for the codeReview task. It swallows a failed
// call and returns []; a refused call (key, quota, rate, outage) did not
// measure, an answer that did not fit the schema is the recovery's own result.
const REFUSED = new Set(['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED', 'TRANSIENT'].map((c) => LlmErrorCategory[c]));
async function runCase(testCase, slot) {
    const { result, errors } = await withCallErrors(() => recoverFindingsFromProse(testCase.prose, slot, EVAL_ORG.organizationId, 'prose-recovery-eval'));
    const answered = (e) => e?.name === 'AI_NoObjectGeneratedError' || /^No object generated/.test(String(e?.message));
    const refusal = errors.find((e) => !answered(e) && REFUSED.has(classifyLLMError(e).category));
    if (!result?.length && refusal) throw new Error(`prose recovery call refused: ${String(refusal?.message || refusal).slice(0, 200)}`);
    return (result || []).map((f) => ({ file: f.relevantFile || '', text: String(f.suggestionContent || '').slice(0, 300) }));
}

const norm = (f) => String(f || '').trim().replace(/^\.?\//, '');
const sameFile = (a, b) => norm(a) === norm(b) || norm(a).endsWith(`/${norm(b)}`) || norm(b).endsWith(`/${norm(a)}`);

// Each expected file is one check (a finding on it came out). A case built with
// dismissed hypotheses adds one check: none came out — with nothing expected,
// no finding at all; otherwise none on a dismissed file.
function score(testCase, extracted) {
    const detail = testCase.expected.files.map((file) => ({ what: `extracts ${file}`, kind: 'extract', ok: extracted.some((f) => sameFile(f.file, file)) }));
    if (testCase.dismissed.files.length) {
        const leaked = testCase.expected.files.length
            ? extracted.filter((f) => testCase.dismissed.files.some((d) => sameFile(f.file, d)))
            : extracted;
        detail.push({ what: 'extracts no dismissed hypothesis', kind: 'dismissed', ok: leaked.length === 0, leaked: leaked.length });
    }
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail, extracted };
}

async function main() {
    const route = orgRouteOrExit(MODEL);
    const slot = routeCodeReviewModel(route.storedConfig, {}).resolvedModelSlot;
    const results = new Array(cases.length);
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const testCase = cases[i];
            const t0 = Date.now();
            try {
                // eslint-disable-next-line no-await-in-loop
                results[i] = { id: testCase.id, checks: testCase.checks, ...score(testCase, await runCase(testCase, slot)), ms: Date.now() - t0 };
            } catch (error) {
                console.error(`  ${testCase.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: testCase.id, checks: testCase.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 6) }, worker));

    const measured = results.filter((r) => !r.unmeasured);
    const errored = results.length - measured.length;
    const hits = measured.reduce((n, r) => n + r.hits, 0);
    const total = measured.reduce((n, r) => n + r.total, 0);
    const share = (kind) => {
        const checks = measured.flatMap((r) => r.detail.filter((d) => d.kind === kind));
        return { right: checks.filter((d) => d.ok).length, total: checks.length, value: checks.length ? checks.filter((d) => d.ok).length / checks.length : null };
    };
    const result = {
        eval: 'prose-recovery',
        question: evalQuestion('evals/prose-recovery'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of the checks, findings extracted and dismissed hypotheses left out', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        metrics: {
            extracted: share('extract'),
            dismissedLeftOut: share('dismissed'),
            dismissedFindings: measured.reduce((n, r) => n + (r.detail.find((d) => d.kind === 'dismissed')?.leaked || 0), 0),
        },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    const m = result.metrics;
    console.log(`${result.eval}: ${hits}/${total} · extracted ${m.extracted.right}/${m.extracted.total} · dismissed left out ${m.dismissedLeftOut.right}/${m.dismissedLeftOut.total} (${m.dismissedFindings} findings leaked) · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor !== null && result.metric.value < result.metric.floor) return 1;
    return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });
