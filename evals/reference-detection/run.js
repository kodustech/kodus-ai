#!/usr/bin/env node
// reference-detection: production's ReferenceDetectorService.detectReferencesWithStatus
// on Kody rules, the model routed as production routes it for this step
// (resolveTaskSlot codeReview, as create-or-update.use-case.ts does), scored
// against the files each rule cites.
//
//   node evals/reference-detection/run.js [--model=<id>] [--repeat=N] [--gate] [--output=<result.json>] [--limit=N]
//
// --repeat  runs every case N times (case ids get #1..#N): the #2409 cases leak on
//           some calls only, so they are read over ten.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true, quiet: true });
// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const MODEL = args.model || 'eval-fake';
const REPEAT = Math.max(1, Number(args.repeat) || 1);
const base = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);
const cases = REPEAT === 1 ? base : base.flatMap((c) => Array.from({ length: REPEAT }, (_, k) => ({ ...c, id: `${c.id}#${k + 1}` })));
const floor = (require('./targets.json').models[MODEL] || {}).floor ?? null;

// The rule's text, as a Kody rule save hands it to detection: production's own
// service, the slot production's permission service routes for this step.
async function runCase(testCase, env) {
    const { ReferenceDetectorService } = require('../../libs/ai-engine/infrastructure/adapters/services/reference-detector.service.ts');
    return new ReferenceDetectorService().detectReferencesWithStatus({
        requirementId: `eval:${testCase.id}`,
        promptText: testCase.input.rule,
        organizationAndTeamData: EVAL_ORG,
        context: 'rule',
        detectionMode: 'rule',
        byokConfig: env.slot ?? undefined,
    });
}

// Right when the answer is reliable, names every cited file, and names nothing else.
function score(testCase, output) {
    const got = (output.references || []).map((r) => r.fileName || r.filePath);
    const detail = [
        { what: `a reliable answer (got ${output.reliable ? 'reliable' : 'unreliable: not cached, retried'})`, ok: output.reliable === true },
        ...testCase.expected.items.map((file) => ({ what: `finds ${file}`, ok: got.includes(file) })),
        { what: `names no other file${got.filter((f) => !testCase.expected.items.includes(f)).length ? ` (got ${got.filter((f) => !testCase.expected.items.includes(f)).join(', ')})` : ''}`, ok: got.every((f) => testCase.expected.items.includes(f)) },
    ];
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    // The org's model, routed as production routes it.
    const route = orgRouteOrExit(MODEL);
    const { LLM_TASK } = require('../../libs/llm/byok-config.ts');
    const slot = await evalPermissionService(route.storedConfig).resolveTaskSlot(EVAL_ORG, LLM_TASK.codeReview);
    countTokens();
    const results = [];
    let errored = 0;
    for (const testCase of cases) {
        try {
            results.push({ id: testCase.id, checks: testCase.checks, ...score(testCase, await runCase(testCase, { slot })) });
        } catch (error) {
            errored += 1;
            console.error(`  ${testCase.id}: ${String(error.message || error).slice(0, 200)}`);
            results.push({ id: testCase.id, checks: testCase.checks, hits: 0, total: 0, unmeasured: true });
        }
    }
    for (const r of results.filter((x) => !x.unmeasured)) {
        console.log(`${r.hits === r.total ? '✅' : '❌'} ${r.id.padEnd(36)} ${r.hits}/${r.total}`);
        for (const d of r.detail.filter((x) => !x.ok)) console.log(`      · ${d.what}`);
    }
    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'reference-detection',
        question: evalQuestion('evals/reference-detection'),
        model: MODEL,
        runs: REPEAT,
        metric: { name: 'of reference checks passed', value: total ? hits / total : null, floor, baseline: null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(`${result.eval}: ${hits}/${total} · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && floor !== null && result.metric.value < floor) return 1;
    return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });
