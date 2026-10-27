// What every stage eval over the frozen snapshot shares (evals/funnel/<stage>):
// for each nightly PR, the input production's step received in the snapshot's
// review (snapshot.js) goes through that step's production method again, with
// what the step reads besides (the changed files, the team's config, the routed
// model, the agent's runner and tools) rebuilt by production's code from the
// PR's data (evals/shared/review-stage.js). Then the stage's control pair
// (controls.js) the same way.
//
//   node evals/funnel/<stage>/run.js [--model=<id>] [--set=controlled|full] [--snapshot=<model>] [--embedder=platform|none] [--gate] [--output=<file>] [--limit=N] [--cases=<id,id>] [--concurrency=N] [--controls]
//
// --model     the model an LLM stage runs on (the nightly model by default)
// --set       controlled (default): the snapshot's PRs of the finder's controlled
//             set (evals/investigation/recall-tests.js), what the nightly and every
//             model's weekly run measure; full: every snapshot PR. Each set has
//             its own floors (targets.json `sets.<set>.models`)
// --snapshot  whose frozen input to read (snapshot/<id>.json)
// --controls  the control pair only: a repository written for it, no GitHub
// --embedder  a stage that embeds (the dedup): platform (default) or none, as a
//             self-hosted install without the platform's OpenAI key (shared/embedder.js)
//
// A known bug reaches the stage when one of the findings it gets matches it,
// and survives when one that matches it comes out. The metric counts those and
// the control pair's checks. A stage with no floor for the model reports
// `ungated`: measured, not compared, no alert.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { knownBugs, datasetFor } = require('./known-bugs');
const { caseSentence } = require('./catalog');
const { CONTROLS, CONTROL_PR, scoreControl } = require('./controls');
const { CASE_SETS } = require('../investigation/recall-tests');
const { parseEmbedder, applyEmbedder, watchEmbeddings } = require('../shared/embedder');

// Which snapshot PRs each set reads.
const SETS = {
    controlled: (caseId) => CASE_SETS.controlled.includes(caseId),
    full: () => true,
};

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );

// A refused call (key, quota, model) leaves the case unmeasured; any other
// failed call is the step's own fallback, scored as production ships it.
function refusal(errors) {
    const { classifyLLMError, LlmErrorCategory } = require('../../libs/llm/error-classifier.ts');
    const refused = ['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED'].map((c) => LlmErrorCategory[c]);
    return errors.find((e) => refused.includes(classifyLLMError(e).category));
}

/**
 * @param stage.id        the eval's folder under evals/funnel, and its step in the snapshot's cases
 * @param stage.usesModel whether the step calls a model (the run is then routed to --model)
 * @param stage.apply     async ({ pr, team, route, permissionService }, frozen) => the indexes of
 *                        inputOf(frozen) that come out of the step
 * @param stage.inputOf   (frozen) => the findings the step gets, in order (default frozen.candidates)
 * @param stage.controlInput (findings) => a control's findings as the step's frozen input
 * @param stage.embedder  whether the step embeds (it then takes --embedder and records the embedder)
 */
async function runStage(stage) {
    const args = parseArgs(process.argv.slice(2));
    const MODEL = args.model || 'deepseek-v4-flash@fireworks';
    const SNAPSHOT = args.snapshot || 'deepseek-v4-flash@fireworks';
    const SET = args.set || 'controlled';
    if (!SETS[SET]) {
        console.error(`unknown --set=${SET}: ${Object.keys(SETS).join(' or ')}`);
        process.exit(2);
    }
    if (args.embedder !== undefined && !stage.embedder) {
        console.error(`--embedder: ${stage.id} does not embed`);
        process.exit(2);
    }
    let embedder = null;
    if (stage.embedder) {
        try {
            embedder = parseEmbedder(args.embedder);
        } catch (error) {
            console.error(error.message);
            process.exit(2);
        }
    }
    const dir = path.join(__dirname, stage.id);
    const TARGET = ((require(path.join(dir, 'targets.json')).sets || {})[SET]?.models || {})[MODEL] || {};
    // libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
    if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
    process.env.RECALL_MODEL = MODEL;
    const { internals } = require('../investigation/agent-provider');
    countTokens();
    const environment = stage.embedder ? watchEmbeddings(embedder) : null;
    // A step that calls no model still reads the routed config; it routes nowhere.
    const route = stage.usesModel ? internals.resolveRoute({ provider: 'tier0', model: MODEL }) : { storedConfig: null, route: 'none' };
    if (embedder) applyEmbedder(embedder);
    const permissionService = internals.evalPermissionService(route.storedConfig);
    const inputOf = stage.inputOf || ((frozen) => frozen.candidates);

    // eslint-disable-next-line global-require, import/no-dynamic-require
    const snapshot = require(path.join(__dirname, 'snapshot', `${SNAPSHOT.replace(/[^\w.@-]+/g, '-')}.json`));
    const only = args.cases ? new Set(String(args.cases).split(',')) : null;
    const inSet = SETS[SET];
    const cases = args.controls ? [] : snapshot.cases.filter((c) => inSet(c.caseId) && (!only || only.has(c.caseId))).slice(0, args.limit ? Number(args.limit) : undefined);
    const controls = CONTROLS[stage.id] || [];
    const run = async (vars, frozen) => {
        const { result, errors } = await withCallErrors(() =>
            stage.apply({ pr: internals.prOf(vars), team: internals.teamOf(vars), route, permissionService }, frozen),
        );
        const refused = refusal(errors);
        if (refused) throw new Error(`${stage.id} call refused: ${String(refused.message || refused).slice(0, 160)}`);
        return result;
    };

    const jobs = [
        ...cases.map((c) => async () => {
            const frozen = c[stage.id];
            const input = inputOf(frozen);
            const bugs = knownBugs(c.caseId);
            const reaching = [...new Set(input.filter((x) => x.bug !== null).map((x) => x.bug))];
            const checks = caseSentence(c.caseId, stage.id, reaching.length, bugs.length);
            try {
                const out = reaching.length ? await run(datasetFor(c.caseId), frozen) : new Set(input.map((_, k) => k));
                const survived = new Set(input.filter((_, k) => out.has(k)).map((x) => x.bug));
                const detail = reaching.map((b) => ({ what: `known bug ${b}: ${bugs[b].text.slice(0, 120)}`, ok: survived.has(b) }));
                const noise = input.filter((x, k) => x.bug === null && !out.has(k)).length;
                return { id: c.caseId, checks, hits: detail.filter((d) => d.ok).length, total: detail.length, detail, removedNoise: noise, candidates: input.length };
            } catch (error) {
                console.error(`  ${c.caseId}: ${String(error.message || error).slice(0, 200)}`);
                return { id: c.caseId, checks, hits: 0, total: 0, unmeasured: true };
            }
        }),
        ...controls.map((control) => async () => {
            try {
                const frozen = stage.controlInput(control.findings.map((finding) => ({ finding, bug: null })));
                const out = await run(CONTROL_PR, frozen);
                return { id: control.id, checks: control.checks, ...scoreControl(control, out), control: true };
            } catch (error) {
                console.error(`  ${control.id}: ${String(error.message || error).slice(0, 200)}`);
                return { id: control.id, checks: control.checks, hits: 0, total: 0, unmeasured: true, control: true };
            }
        }),
    ];

    const results = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const i = next++;
            // eslint-disable-next-line no-await-in-loop
            results[i] = await jobs[i]();
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const errored = results.filter((r) => r.unmeasured).length;
    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const noise = results.reduce((n, r) => n + (r.removedNoise || 0), 0);
    const inputs = results.reduce((n, r) => n + (r.candidates || 0), 0);
    const result = {
        eval: `funnel/${stage.id}`,
        question: evalQuestion(`evals/funnel/${stage.id}`),
        model: MODEL,
        set: SET,
        snapshot: { model: snapshot.model, builtOn: snapshot.builtOn, judge: snapshot.judge },
        runs: 1,
        metric: { name: `of known bugs reaching ${stage.id} kept, and of its control checks right`, value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        // A PR where no known bug reaches the stage has nothing to keep: it is
        // left out of the cases, not shown as 0 of 0.
        cases: results.filter((r) => r.unmeasured || r.total > 0),
        ...(environment ? { environment: environment() } : {}),
        tokens: tokensUsed(),
        infra: { errored, total: jobs.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results.filter((x) => x.hits < x.total)) {
        console.log(`  ${r.id}: ${r.hits}/${r.total} — ${r.control ? 'wrong' : 'lost'} ${r.detail.filter((d) => !d.ok).map((d) => d.what.slice(0, 90)).join('; ')}`);
    }
    const bugCases = results.filter((r) => !r.control);
    const controlCases = results.filter((r) => r.control);
    const sum = (rs, k) => rs.reduce((n, r) => n + r[k], 0);
    console.log(
        `${stage.id}: ${sum(bugCases, 'hits')}/${sum(bugCases, 'total')} known bugs reaching it kept · controls ${sum(controlCases, 'hits')}/${sum(controlCases, 'total')} · ${noise} of ${inputs} findings matching no known bug removed · ${bugCases.filter((r) => !r.unmeasured && !r.total).length} PRs with none reaching it · ${errored} of ${jobs.length} cases did not measure`,
    );
    if (errored > jobs.length * 0.05) {
        console.error(`not measured: ${errored} of ${jobs.length} cases failed (see above)`);
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

// The post-agent steps run on a stage built as the review builds it, over the
// PR's context up to the agents; `evalIndex` marks each frozen finding so what
// comes out maps back to what went in (the steps copy findings, fields kept).
async function onTheStage(env, frozen, step) {
    const { prepareReview, buildAgentReviewStage } = require('../shared/review-stage');
    const { context, codeManagement, cleanup } = await prepareReview(env);
    try {
        const stage = buildAgentReviewStage({ permissionService: env.permissionService, codeManagement });
        const input = frozen.candidates.map((x, k) => ({ ...x.finding, evalIndex: k }));
        const out = await step(stage, input, context);
        return new Set(out.map((s) => s.evalIndex).filter((k) => k !== undefined));
    } finally {
        await cleanup();
    }
}

module.exports = { runStage, main, onTheStage, refusal };
