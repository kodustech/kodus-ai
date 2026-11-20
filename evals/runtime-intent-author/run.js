#!/usr/bin/env node
// runtime-intent-author: Kody Runtime's intent author (docs/runtime/intent-oracle.md)
// on bug/correct pull request pairs that share one description.
//
// Each case is one feature of our own test repo (kr-shop): its PR
// description, its entry points, and what base, the bug PR and the correct PR
// answered to the requests the description talks about. The eval runs
// production's IntentAuthor (apps/runtime/src/worker/intent/intent-author.ts):
// its prompt, its parse and its checks (quotes must be substrings of their
// source, assertions inside the closed set). Each probe it writes whose request
// matches a recorded one is then decided by production's gate
// (libs/runtime/gate: decideProbe, decideNewEndpoint, decideStatedIntent) on
// the recorded answers of each side. A probe whose request was not recorded is
// counted as unscored, never as right or wrong.
//
//   node evals/runtime-intent-author/run.js [--model=<id>] [--reps=N] [--cases=<id,...>] [--output=<result.json>]
//   node evals/runtime-intent-author/run.js --scripted            (each case's scripted answer, no model and no key)
//   node evals/runtime-intent-author/run.js --scripted=observed   (the answers the real Runs gave: a case fixed in the prompt
//        must fail on them, one fixed in the gate or the checks (observedHolds) must hold; exit 1 otherwise)
//
// The regression-* cases are the failure shapes the real model showed on
// first real-model round; each scores one check on the answer of its feature.
//
// --scripted checks the wiring and the gate on hand-written answers; it measures nothing about a model.
// Exit: 0 measured, 2 did not measure (evals/README.md). No floor yet.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const SCRIPTED = !!args.scripted;
const OBSERVED = args.scripted === 'observed';
const MODEL = SCRIPTED ? 'scripted' : args.model || 'deepseek-v4-pro';
const REPS = SCRIPTED ? 1 : Math.max(1, Number(args.reps) || 3);
const ALL = require('./cases.json');
const CASES = ALL.filter((c) => (args.cases ? String(args.cases).split(',').includes(c.id) : true)).filter((c) => !OBSERVED || c.regression);
/** A regression case reads its feature's PR, templates and recorded answers. */
const featureOf = (c) => (c.feature ? { ...ALL.find((f) => f.id === c.feature), ...c } : c);

if (!SCRIPTED) {
    const dotenv = require('dotenv');
    dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
    dotenv.config({ path: path.join(ROOT, '.env.local'), override: true, quiet: true });
    if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true, quiet: true });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
process.env.API_LOG_LEVEL = process.env.EVAL_LOG_LEVEL || 'warn';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const engine = (p) => require(path.join(ROOT, p));
const { IntentAuthor } = engine('apps/runtime/src/worker/intent/intent-author.ts');
const { decideNewEndpoint, decideProbe, decideStatedIntent, statedIntentChecksFor } = engine('libs/runtime/gate/index.ts');
const { expectedHolds, normalizeFields } = engine('libs/runtime/gate/probe-fields.ts');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { tokensUsed } = require('../shared/eval-kit');

const IMAGE = 'eval-image';
const TARGET = { service: 'app', port: 3000 };

/** The model route: production's gateway use case and BYOK provider on the org's stored config (as evals/runtime-intent). */
function modelGateway() {
    const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
    const { countTokens } = require('../shared/eval-kit');
    const { RuntimeLlmGatewayUseCase } = engine('libs/runtime/api/application/use-cases/llm-gateway.use-case.ts');
    const { ByokRuntimeLlmProvider, permissionSlotResolver } = engine('libs/runtime/api/infrastructure/byok-runtime-llm.provider.ts');
    const { loadRuntimeApiConfig } = engine('libs/runtime/api/infrastructure/runtime-api.config.ts');
    const { signRunToken } = engine('libs/runtime/api/domain/run-token.ts');
    const { InMemoryRunProjectionStore } = engine('libs/runtime/run/testing/in-memory-run-projection.store.ts');
    const config = loadRuntimeApiConfig({ RUNTIME_RUN_TOKEN_SECRET: crypto.randomBytes(32).toString('hex') });
    const route = orgRouteOrExit(MODEL);
    countTokens();
    const projections = new InMemoryRunProjectionStore();
    const budget = {
        async reserve({ decide }) {
            const tokens = decide({ run: 0, pullRequest: 0, orgToday: 0 });
            return tokens === null ? null : { reservationId: crypto.randomUUID(), tokens };
        },
        async settle() {},
        async cancel() {},
    };
    const gateway = new RuntimeLlmGatewayUseCase(projections, budget, new ByokRuntimeLlmProvider(permissionSlotResolver(evalPermissionService(route.storedConfig))), config, () => new Date());
    return {
        async open(caseId) {
            const runId = crypto.randomUUID();
            const now = new Date();
            const orgTeam = { organizationId: EVAL_ORG.organizationId, teamId: EVAL_ORG.teamId };
            await projections.upsert(runId, {
                runId, attempt: 1, correlationId: `eval-${runId}`, ...orgTeam, repositoryId: `eval-intent-author-${caseId}`, repositoryName: `eval/${caseId}`, prNumber: 1,
                headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), environmentId: 'eval-env', imageId: IMAGE, state: 'testing', requestedAt: now.toISOString(), updatedAt: now.toISOString(),
            });
            const runToken = signRunToken({ runId, attempt: 1, ...orgTeam, repositoryId: `eval-intent-author-${caseId}`, prNumber: 1, maxTokens: config.llmBudget.perRun, exp: Math.floor(now.getTime() / 1000) + 3_600 }, config.runTokenSecret);
            return { runId, organizationId: orgTeam.organizationId, runToken };
        },
        llm: {
            complete: async (r) => {
                const started = Date.now();
                const out = await gateway.execute({ authorization: `Bearer ${r.runToken}`, body: { runId: r.runId, task: r.task, messages: r.messages } });
                return { text: out.text, usage: { ...out.usage, ms: Date.now() - started } };
            },
        },
    };
}

/** Each case's scripted answer, as the model's turn: the wiring and the gate, no model. */
const scriptedGateway = () => ({
    open: async () => ({ runId: crypto.randomUUID(), organizationId: 'eval-org', runToken: 'scripted' }),
    llm: { complete: async (r) => ({ text: r.scripted, usage: { inputTokens: 0, outputTokens: 0, ms: 0 } }) },
});

/** A recorded answer as the observer returns it: a JSON body, or a text body with its content type (`contentType`). */
const httpOf = (answer) => ({
    http: { status: answer.status, headers: { 'content-type': answer.contentType ?? 'application/json' }, body: typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body) },
});

const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const bodyKey = (b) => (b === undefined || b === '' ? '' : JSON.stringify(canonical(typeof b === 'string' ? JSON.parse(b) : b)));
const sameRequest = (spec, recorded) => spec.method === recorded.method && spec.path === recorded.path && bodyKey(spec.body) === bodyKey(recorded.body);

/** The recorded answers played as the replay plays rounds, until production's gate decides; then the intent verdict. */
function decide(probe, check, recorded, side) {
    const steps = [];
    let n = 0;
    const play = (s, answer) => {
        const result = httpOf(answer);
        const round = steps.filter((x) => x.side === s).length + 1;
        steps.push({
            stepId: `s${++n}`, probeId: probe.id, side: s, round, executor: 'observer', imageId: IMAGE, transport: 'ok', vmHealth: 'ok', timedOut: false,
            fields: normalizeFields(probe, result), expectedHolds: expectedHolds(probe, result, undefined, [check]), readyStatus: 200,
        });
    };
    play('base', recorded.base);
    play('base', recorded.base);
    play('pr', recorded[side]);
    let d = decideProbe(steps, { pinnedImageId: IMAGE });
    while (d.kind === 'more_rounds') {
        for (let i = 0; i < d.base; i++) play('base', recorded.base);
        for (let i = 0; i < d.pr; i++) play('pr', recorded[side]);
        d = decideProbe(steps, { pinnedImageId: IMAGE });
    }
    const added = decideNewEndpoint(d, steps, { addedByDiff: !!recorded.addedByDiff });
    return decideStatedIntent(added, steps, [check], { mismatch: true, pinnedImageId: IMAGE, ...(probe.spec.body ? { requestBody: probe.spec.body } : {}) }).decision.verdict;
}

/** The planner's probe of a recorded request, as the Run has it. */
const plannedProbe = (id, request) => ({
    id,
    origin: 'agent',
    purpose: 'planned',
    expected: '200',
    compare: ['status', 'json'],
    spec: { kind: 'http', target: TARGET, method: request.method, path: request.path, ...(request.body !== undefined ? { body: JSON.stringify(request.body), headers: { 'Content-Type': 'application/json' } } : {}), timeoutMs: 30_000 },
});

/** The verdict of a planned probe of a recorded request once the intent checks of its request or route apply (run-orchestrator.ts replayIntentProbes). */
function plannedVerdict(recorded, route, probes, side) {
    const probe = plannedProbe('planned', recorded.request);
    const { checks, explainOnly } = statedIntentChecksFor({ probe, entryPoint: route }, probes);
    if (!checks.length) return 'finding';
    const steps = [];
    let n = 0;
    const play = (s, answer) => {
        const result = httpOf(answer);
        steps.push({ stepId: `s${++n}`, probeId: probe.id, side: s, round: steps.filter((x) => x.side === s).length + 1, executor: 'observer', imageId: IMAGE, transport: 'ok', vmHealth: 'ok', timedOut: false, fields: normalizeFields(probe, result), expectedHolds: true, readyStatus: 200 });
    };
    for (let i = 0; i < 2; i++) play('base', recorded.base);
    for (let i = 0; i < 2; i++) play('pr', recorded[side]);
    const d = decideProbe(steps, { pinnedImageId: IMAGE });
    if (d.kind !== 'verdict') return 'inconclusive';
    const out = decideStatedIntent(d, steps, checks, { mismatch: false, pinnedImageId: IMAGE });
    return explainOnly && out.decision.verdict !== 'described_change' ? d.verdict : out.decision.verdict;
}

const bodyOf = (p) => (p.probe.spec.body ? JSON.parse(p.probe.spec.body) : undefined);
const queryOf = (p) => new URLSearchParams(p.probe.spec.path.split('?')[1] ?? '');

/** One regression check on the author's answer (cases.json `regression`). */
function regressionHolds(c, out, feature) {
    const r = c.regression;
    const on = (route) => out.probes.filter((p) => `${p.probe.spec.method} ${p.probe.spec.path.split('?')[0]}` === route);
    switch (r.shape) {
        case 'body_fields': {
            const probes = on(r.route);
            return probes.length > 0 && probes.every((p) => r.fields.every((f) => bodyOf(p) && Object.prototype.hasOwnProperty.call(bodyOf(p), f)));
        }
        case 'bug_caught_with_text_parameter': {
            const probes = out.probes.filter((p) => p.probe.spec.path.split('?')[0] === r.path);
            return feature.bugCaught && probes.some((p) => queryOf(p).has(r.param)) && !probes.some((p) => queryOf(p).has(r.not));
        }
        case 'bug_caught':
            return feature.bugCaught;
        case 'answer_parsed':
            return !out.dropped.some((d) => /not the JSON object/.test(d.reason));
        case 'probe_written':
            return out.probes.length > 0;
        case 'correct_described':
            return feature.correctDescribed;
        case 'no_false_mismatch':
            return !feature.correctFlagged;
        case 'correct_not_regression':
            return feature.correctVerdicts.length > 0 && !feature.correctVerdicts.includes('finding');
        case 'correct_not_flagged':
            return out.probes.some((p) => c.recorded.some((x) => !x.planned && sameRequest(p.probe.spec, x.request))) && !feature.correctFlagged;
        case 'route_rule': {
            const recorded = c.recorded.find((x) => x.planned && x.request.path === r.planned);
            return plannedVerdict(recorded, r.route, out.probes, 'correct') === 'described_change';
        }
        default:
            throw new Error(`unknown regression shape ${r.shape}`);
    }
}

async function runCase(raw, rep, gw) {
    const c = featureOf(raw);
    const ctx = await gw.open(c.id);
    const answer = OBSERVED ? c.observed : c.scripted;
    const author = new IntentAuthor({ complete: (r) => gw.llm.complete({ ...r, scripted: answer }) });
    const input = {
        title: c.pullRequest.title,
        description: c.pullRequest.description,
        ...(c.pullRequest.linkedTasks ? { linkedTasks: c.pullRequest.linkedTasks } : {}),
        entryPoints: c.entryPoints,
        target: TARGET,
        ...(c.requestTemplates ? { requestTemplates: c.requestTemplates } : {}),
    };
    const out = await author.author(input, ctx);
    if (out.status !== 'authored') return { id: c.id, rep, unmeasured: out.status === 'unavailable' ? out.reason : out.status };
    const sides = { bug: [], correct: [] };
    let unscored = 0;
    for (const p of out.probes) {
        const recorded = c.recorded.find((r) => !r.planned && sameRequest(p.probe.spec, r.request));
        if (!recorded) {
            unscored++;
            continue;
        }
        const check = { probeId: p.probe.id, intent: p.intent, assertions: p.intentAssertions };
        for (const side of ['bug', 'correct']) if (recorded[side]) sides[side].push(decide(p.probe, check, recorded, side));
    }
    const scored = sides.bug.length > 0 || sides.correct.length > 0;
    const feature = {
        bugCaught: scored && sides.bug.includes('intent_mismatch'),
        correctFlagged: sides.correct.includes('intent_mismatch'),
        correctDescribed: sides.correct.includes('described_change'),
        correctVerdicts: sides.correct,
    };
    const row = { id: c.id, rep, probes: out.probes.length, dropped: out.dropped.length, unscored, scored, ...feature, verdicts: sides, usage: out.usage };
    if (c.regression) {
        const ok = regressionHolds(c, out, feature);
        const expected = OBSERVED ? !!c.observedHolds : true;
        return { ...row, regression: true, scored: true, hits: ok ? 1 : 0, total: 1, asExpected: ok === expected, what: `rep ${rep + 1}: ${c.regression.shape} ${ok ? 'holds' : 'FAILS'}${OBSERVED ? (ok === expected ? ' (as expected)' : ' (UNEXPECTED)') : ''}` };
    }
    return {
        ...row,
        hits: scored ? (feature.bugCaught ? 1 : 0) + (feature.correctFlagged ? 0 : 1) : 0,
        total: scored ? 2 : 0,
        what: `rep ${rep + 1}: bug ${feature.bugCaught ? 'caught' : 'missed'}, correct ${feature.correctFlagged ? 'flagged' : 'not flagged'}`,
    };
}

async function main() {
    if (!CASES.length) {
        console.error('not measured: no case selected');
        return 2;
    }
    const gw = SCRIPTED ? scriptedGateway() : modelGateway();
    const rows = [];
    for (const c of CASES) {
        for (let rep = 0; rep < REPS; rep++) {
            try {
                const r = await runCase(c, rep, gw);
                rows.push(r);
                const said = r.regression ? r.what : `probes ${r.probes} (dropped ${r.dropped}, unscored ${r.unscored})  bug ${r.bugCaught ? 'caught' : 'missed'}  correct ${r.correctFlagged ? 'FLAGGED' : r.correctDescribed ? 'described' : 'not flagged'}`;
                console.log(`  ${c.id.padEnd(32)} rep ${rep + 1}  ${r.unmeasured ? `NOT MEASURED: ${r.unmeasured}` : said}`);
            } catch (error) {
                const message = String(error?.response?.message ?? error?.message ?? error).slice(0, 300);
                console.error(`  ${c.id} rep ${rep + 1}: not measured: ${message}`);
                rows.push({ id: c.id, rep, unmeasured: message });
            }
        }
    }
    const measured = rows.filter((r) => !r.unmeasured && r.scored);
    const cases = CASES.map((c) => {
        const mine = measured.filter((r) => r.id === c.id);
        return {
            id: c.id,
            checks: c.checks,
            hits: mine.reduce((n, r) => n + r.hits, 0),
            total: mine.reduce((n, r) => n + r.total, 0),
            detail: mine.map((r) => ({ what: r.what, ok: r.hits === r.total })),
        };
    });
    const hits = cases.reduce((n, c) => n + c.hits, 0);
    const total = cases.reduce((n, c) => n + c.total, 0);
    const result = {
        eval: 'runtime-intent-author',
        question: evalQuestion('evals/runtime-intent-author'),
        model: MODEL,
        runs: REPS,
        metric: { name: 'bugs caught and correct PRs not flagged', value: total ? hits / total : null, floor: null },
        summary: {
            regressionsHeld: measured.filter((r) => r.regression && r.hits === 1).length,
            regressions: measured.filter((r) => r.regression).length,
            bugsCaught: measured.filter((r) => !r.regression && r.bugCaught).length,
            correctFlagged: measured.filter((r) => !r.regression && r.correctFlagged).length,
            correctDescribed: measured.filter((r) => !r.regression && r.correctDescribed).length,
            scored: measured.filter((r) => !r.regression).length,
            unscoredRuns: rows.filter((r) => !r.unmeasured && !r.scored).length,
            unscoredProbes: rows.reduce((n, r) => n + (r.unscored ?? 0), 0),
        },
        cases,
        // Zeros with --scripted: no model call is made.
        tokens: tokensUsed(),
        infra: { errored: rows.filter((r) => r.unmeasured).length, total: rows.length },
    };
    const sm = result.summary;
    console.log(`\n${OBSERVED ? 'observed answers' : MODEL}: ${sm.bugsCaught}/${sm.scored} bugs caught, ${sm.correctFlagged}/${sm.scored} correct PRs flagged, ${sm.correctDescribed} described, ${sm.unscoredRuns} runs unscored; regressions held ${sm.regressionsHeld}/${sm.regressions}`);
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (result.infra.errored > result.infra.total * 0.05 || !measured.length) {
        console.error(`not measured: ${result.infra.errored} of ${result.infra.total} runs errored, ${measured.length} scored`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape: ${problems.join('; ')}`);
        return 2;
    }
    // --scripted=observed: a shape fixed in the gate or the checks holds on the answer the Run gave, one fixed in the prompt fails on it.
    if (OBSERVED && measured.some((r) => r.regression && !r.asExpected)) {
        console.error('observed answers: a regression case did not end as its observedHolds says');
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
