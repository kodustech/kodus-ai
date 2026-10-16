// What every stage eval over the frozen snapshot shares (evals/funnel/<stage>):
// read the finder's frozen candidates (snapshot.js), hand each PR's candidates
// that reach the stage to the stage's production code, and count the known
// bugs that reach the stage and survive it.
//
//   node evals/funnel/<stage>/run.js [--model=<id>] [--snapshot=<model>] [--gate] [--output=<file>] [--limit=N] [--cases=<id,id>] [--concurrency=N]
//
// --model     the model an LLM stage runs on (the nightly model by default)
// --snapshot  whose frozen finder output to read (snapshot/<id>.json)
//
// A known bug reaches the stage when one of the candidates it gets matches it,
// and survives when one that matches it comes out. A stage with no floor for
// the model reports `ungated`: measured, not compared, no alert.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { knownBugs } = require('./known-bugs');

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );

/**
 * @param stage.id        the eval's folder under evals/funnel
 * @param stage.reaches   (candidate) => whether it reaches the stage (default: kept by verify)
 * @param stage.apply     async (candidates, caseId) => the indexes of the candidates that come out
 * @param stage.usesModel whether the stage calls a model (then --model is routed)
 */
async function runStage(stage) {
    const args = parseArgs(process.argv.slice(2));
    const MODEL = args.model || 'deepseek-v4-flash@fireworks';
    const SNAPSHOT = args.snapshot || 'deepseek-v4-flash@fireworks';
    const dir = path.join(__dirname, stage.id);
    const TARGET = (require(path.join(dir, 'targets.json')).models || {})[MODEL] || {};
    // libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
    if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
    if (stage.usesModel) applyModelEnv(MODEL);
    countTokens();

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const snapshot = require(path.join(__dirname, 'snapshot', `${SNAPSHOT.replace(/[^\w.@-]+/g, '-')}.json`));
    const only = args.cases ? new Set(String(args.cases).split(',')) : null;
    const cases = snapshot.cases.filter((c) => !only || only.has(c.caseId)).slice(0, args.limit ? Number(args.limit) : undefined);
    const reaches = stage.reaches || ((c) => c.kept);

    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            const input = c.candidates.filter(reaches);
            const bugs = knownBugs(c.caseId);
            const reaching = [...new Set(input.filter((x) => x.bug !== null).map((x) => x.bug))];
            const checks = `Keeps the known bugs of ${c.caseId} that reach ${stage.id} (${reaching.length} of ${bugs.length})`.slice(0, 160);
            try {
                const out = new Set(reaching.length || stage.always ? await stage.apply(input, c.caseId) : input.map((_, k) => k));
                const survived = new Set(input.filter((_, k) => out.has(k)).map((x) => x.bug));
                const detail = reaching.map((b) => ({ what: `known bug ${b}: ${bugs[b].text.slice(0, 120)}`, ok: survived.has(b) }));
                const noise = input.filter((x, k) => x.bug === null && !out.has(k)).length;
                results[i] = { id: c.caseId, checks, hits: detail.filter((d) => d.ok).length, total: detail.length, detail, removedNoise: noise, candidates: input.length };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.caseId}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.caseId, checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const noise = results.reduce((n, r) => n + (r.removedNoise || 0), 0);
    const inputs = results.reduce((n, r) => n + (r.candidates || 0), 0);
    const result = {
        eval: `funnel/${stage.id}`,
        question: evalQuestion(`evals/funnel/${stage.id}`),
        model: MODEL,
        snapshot: { model: snapshot.model, builtOn: snapshot.builtOn, judge: snapshot.judge },
        runs: 1,
        metric: { name: `of known bugs reaching ${stage.id} kept`, value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results.filter((x) => x.hits < x.total)) {
        console.log(`  ${r.id}: ${r.hits}/${r.total} — lost ${r.detail.filter((d) => !d.ok).map((d) => d.what.slice(0, 90)).join('; ')}`);
    }
    console.log(`${stage.id}: ${hits}/${total} known bugs reaching it kept · ${noise} of ${inputs} candidates matching no known bug removed · ${errored} of ${cases.length} PRs did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} PRs failed (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.log(`ungated: no floor for ${MODEL} in evals/funnel/${stage.id}/targets.json until the relabeled dataset lands`);
        return 0;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/funnel/${stage.id}/targets.json`);
        return 1;
    }
    return 0;
}

function main(stage) {
    runStage(stage)
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(error);
            process.exit(2);
        });
}

module.exports = { runStage, main };
