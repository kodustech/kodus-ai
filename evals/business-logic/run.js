#!/usr/bin/env node
// business-logic: production's BusinessLogicValidationStage on PRs that close a
// Jira ticket, scored on what it publishes (production-stage.js).
//
//   node evals/business-logic/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--verify]
//
// Each case is a PR, its diff and the ticket it closes (cases.json, files/).
// A case is right when the stage records the expected outcome (a gap found, a
// pass, or skipped for a ticket it cannot read) and, for a gap, its published
// comment names what is missing. --verify runs the skill with its verify pass
// on (SkillExecutionPolicy.verifyAnalyzerResult), which production ships off.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { orgRouteOrExit } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
// The org's model, routed as production routes it (evals/shared/model-route.js).
const ROUTE = orgRouteOrExit(MODEL);

// What the stage did, against what the case expects.
function score(c, run) {
    const kind = run.outcome?.kind || 'none';
    const comment = run.published.map((s) => String(s.suggestionContent || '')).join('\n');
    const detail = [{ what: `outcome ${kind}${run.outcome?.reason ? ` (${run.outcome.reason})` : ''}, expected ${c.expect.outcome}`, ok: kind === c.expect.outcome }];
    for (const word of c.expect.mentions || []) {
        detail.push({ what: `published comment names "${word}"`, ok: new RegExp(word, 'i').test(comment) });
    }
    return { hits: detail.every((d) => d.ok) ? 1 : 0, total: 1, detail };
}

async function main() {
    const harness = require('./production-stage');
    // The stage's ObservabilityService registers itself as the LLM port when it
    // is built; the count registers after it, so every call is counted.
    harness.observability();
    countTokens();
    const world = { current: null };
    const services = await harness.startServices(world);
    const results = [];
    let errored = 0;
    try {
        for (const c of cases) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const run = await harness.reviewCase(world, c, { verifyAnalyzerResult: !!args.verify, storedConfig: ROUTE.storedConfig });
                // A stage that threw recorded it as an error outcome: not a measurement.
                if (run.outcome?.kind === 'error') throw new Error(run.outcome.message);
                results.push({ id: c.id, checks: c.checks, ...score(c, run) });
                console.log(`  ${c.id.padEnd(22)} ${results[results.length - 1].detail.map((d) => `${d.ok ? '✓' : '✗'} ${d.what}`).join('  ')}`);
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 240)}`);
                results.push({ id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true });
            }
        }
    } finally {
        await services.close();
    }

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'business-logic',
        question: evalQuestion('evals/business-logic'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of PRs the stage answered right', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(`business-logic: ${hits}/${total} PRs answered right${args.verify ? ' (verify pass on)' : ''} · ${errored} of ${cases.length} cases did not measure`);
    if (errored > 0) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.log(`ungated: no floor for ${MODEL} in evals/business-logic/targets.json (measured, not compared)`);
        return 0;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/business-logic/targets.json`);
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
