#!/usr/bin/env node
// runtime-test-planner: Kody Runtime's test planner (ADR-069) on pull requests
// whose right plan is known, beside the 2-turn loop it replaced (the baseline).
//
// Both sides run production's RuntimeAgent.plan (apps/runtime) with the input
// the run orchestrator builds: the diff through production's Git adapter
// (CodeManagementRuntimeGitAdapter.getPullRequestDiff, diffForRun), the entry
// points from extractEntryPoints without the dependency surface, the changed
// files' content and the environment's targets.
// - planner: WorkerRunPlanClient by default, with the real product model-turn
//   and scoped-source use cases through a no-network HTTP adapter. The model
//   still uses the org's LLM_TASK.runtime slot. --planner-host=product retains
//   RuntimeTestPlannerUseCase for the historical API-hosted comparison.
// - baseline: RuntimeAgent with no planner (the 2-turn loop), its LlmGateway
//   calling RuntimeLlmGatewayUseCase.execute (POST /internal/runtime/llm, minus
//   HTTP) on the same slot.
// The eval supplies data only: the repository (sources.js), the base machine's
// answers to shell commands (base-machines.js), the Run projection, a budget
// store in memory and the org's stored BYOK config (evals/shared/model-route.js).
//
//   node evals/runtime-test-planner/run.js [--model=<id>] [--cases=<id,...>] [--set=full|grafana|synthetic]
//        [--planner-host=worker|product] [--load-env] [--sides=planner,baseline] [--concurrency=N] [--output=<result.json>] [--record] [--gate]
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = path.join(__dirname, '..', '..');
const { selectRun, floorFor, versionsFor } = require('./options');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ALL = require('./cases.json');
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
let selected, CALIBRATION;
try {
    selected = selectRun(args, ALL);
    const target = (require('./targets.json').models || {})[MODEL];
    CALIBRATION = floorFor(selected, ALL, target);
} catch {
    console.error('not measured: invalid selection or unavailable calibration inputs');
    process.exit(2);
}
const { plannerHost: PLANNER_HOST, sides: SIDES, cases: CASES } = selected;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 3);
// Refuse an incompatible gate before loading any credentials or paid services.
if (args.gate && CALIBRATION.floor === null) {
    console.error(`not measured: ${CALIBRATION.reason}`);
    process.exit(2);
}
// Credential-file loading is opt-in; also suppress crypto.ts's transitive dotenv/config.
require('./environment').prepareEnvironment({ root: ROOT, loadEnv: args['load-env'] === true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = crypto.randomBytes(32).toString('hex');
process.env.API_LOG_LEVEL = process.env.EVAL_LOG_LEVEL || 'warn';

const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { githubSource, fixtureSource, codeManagementOver } = require('./sources');
const { machineFor } = require('./base-machines');

const engine = (p) => require(path.join(ROOT, p));
const { createPlannerClient, MemoryReceipts } = require('./planner-host.ts');
const { SealedSecretOpener } = engine('apps/runtime/src/worker/secrets/sealed-tokens.ts');
const { HmacCanaryVault, canaryKeyFrom } = engine('libs/runtime/canary/index.ts');
const { AiSdkAgentRunner } = engine('libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { LlmBudgetExceededError } = engine('apps/runtime/src/worker/agent/llm-gateway.ts');
const { ByokRuntimeModelTurnProvider } = engine('libs/runtime/api/infrastructure/byok-model-turn.provider.ts');
const { RuntimeLlmGatewayUseCase } = engine('libs/runtime/api/application/use-cases/llm-gateway.use-case.ts');
const { ByokRuntimeAgentRunnerFactory, ByokRuntimeLlmProvider, permissionSlotResolver } = engine('libs/runtime/api/infrastructure/byok-runtime-llm.provider.ts');
const { CodeManagementRuntimeGitAdapter } = engine('libs/runtime/api/infrastructure/code-management-git.adapter.ts');
const { loadRuntimeApiConfig } = engine('libs/runtime/api/infrastructure/runtime-api.config.ts');
const { signRunToken } = engine('libs/runtime/api/domain/run-token.ts');
const { diffForRun } = engine('libs/runtime/api/application/run-request-builder.service.ts');
const { InMemoryRunProjectionStore } = engine('libs/runtime/run/testing/in-memory-run-projection.store.ts');
const { extractEntryPoints } = engine('libs/runtime/entry-points/extract.ts');
const { checkPlanSubmission, planProblems, unmappedFilesOf } = engine('libs/runtime/contracts/run-plan.ts');
const { SUBMIT_PLAN_TOOL } = engine('libs/runtime/api/application/test-planner/test-planner.agent.ts');
const { RuntimeAgent } = engine('apps/runtime/src/worker/agent/runtime-agent.ts');

// The Run token's secret for this process only; the budget is production's default (runtime-api.config.ts).
const SEAL_KEY = crypto.randomBytes(32);
const CONFIG = loadRuntimeApiConfig({ RUNTIME_RUN_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'), RUNTIME_SECRET_SEAL_KEY: SEAL_KEY.toString('hex') });
const clock = () => new Date();

/** The Run's LLM budget, in memory (the Mongo store's reserve/settle contract). */
class MemoryBudget {
    rows = [];
    seq = 0;
    sum = (rows) => rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    async reserve({ usage, orgDayStart, decide }) {
        const tokens = decide({
            run: this.sum(this.rows.filter((r) => r.runId === usage.runId)),
            pullRequest: this.sum(this.rows.filter((r) => r.organizationId === usage.organizationId && r.repositoryId === usage.repositoryId && r.prNumber === usage.prNumber)),
            orgToday: this.sum(this.rows.filter((r) => r.organizationId === usage.organizationId && r.at >= orgDayStart)),
        });
        if (tokens === null) return null;
        const id = `res-${++this.seq}`;
        this.rows.push({ ...usage, inputTokens: tokens, outputTokens: 0, id, pending: true });
        return { reservationId: id, tokens };
    }
    async settle(id, actual) {
        const row = this.rows.find((r) => r.id === id);
        if (row) Object.assign(row, actual, { pending: false });
    }
    async cancel(id) {
        this.rows = this.rows.filter((r) => r.id !== id);
    }
}

// Per side and case: what the planner's tools did and what the machine was asked (read by wrapping, never replacing).
const traceScope = new AsyncLocalStorage();
global.__EVAL_CASE_ALS = global.__EVAL_CASE_ALS || new AsyncLocalStorage();

/** The production runner, with each tool's execute wrapped to note the call and its outcome. */
function traced(runner) {
    return {
        run: (spec, input, ctx) => {
            const trace = traceScope.getStore();
            for (const tool of spec.tools.list()) {
                const execute = tool.execute;
                tool.execute = async (...a) => {
                    const out = await execute.apply(tool, a);
                    if (trace) {
                        const i = a[0] || {};
                        trace.tools.push({
                            round: trace.rounds,
                            name: tool.name,
                            arg: String(i.path ?? i.text ?? (Array.isArray(i.commands) ? i.commands.join(' ; ') : '')).slice(0, 200),
                            error: !!out?.isError,
                            ...(tool.name === SUBMIT_PLAN_TOOL ? { output: String(out?.output ?? '').slice(0, 2_000), submitted: a[0] } : {}),
                        });
                    }
                    return out;
                };
            }
            return runner.run(spec, input, ctx);
        },
    };
}

const runAgent = AiSdkAgentRunner.prototype.run;
AiSdkAgentRunner.prototype.run = function (...input) {
    return traced({ run: runAgent.bind(this) }).run(...input);
};

function sourceOf(testCase) {
    if (testCase.source.github) {
        const g = testCase.source.github;
        return { source: githubSource(g), repositoryName: g.repo, prNumber: g.pr, shas: { base: g.baseSha, head: g.headSha, baseRef: g.baseSha, headRef: g.headSha } };
    }
    const source = fixtureSource(path.join(__dirname, 'fixtures', testCase.source.fixture));
    return { source, repositoryName: `eval/${testCase.source.fixture}`, prNumber: 1, shas: { base: 'b'.repeat(40), head: 'a'.repeat(40), baseRef: 'base', headRef: 'head' } };
}

/** The 2-turn loop's answer as production reads it (runtime-agent.ts parseJson). */
function parsedAnswer(text) {
    const m = /\{[\s\S]*\}/.exec(text || '');
    if (!m) return undefined;
    try {
        return JSON.parse(m[0]);
    } catch {
        return undefined;
    }
}

async function runSide(side, testCase, deps) {
    const { source, repositoryName, prNumber, shas } = sourceOf(testCase);
    await source.check();
    const runId = crypto.randomUUID();
    const repositoryId = `eval-${testCase.id}`;
    const orgTeam = { organizationId: EVAL_ORG.organizationId, teamId: EVAL_ORG.teamId };
    const now = clock();
    await deps.projections.upsert(runId, {
        runId, attempt: 1, correlationId: `eval-${runId}`, ...orgTeam, repositoryId, repositoryName, prNumber,
        headSha: shas.head, baseSha: shas.base, environmentId: 'eval-env', imageId: 'eval-image', state: 'testing',
        requestedAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    const token = signRunToken(
        { runId, attempt: 1, ...orgTeam, repositoryId, prNumber, maxTokens: CONFIG.llmBudget.perRun, exp: Math.floor(now.getTime() / 1000) + 3_600 },
        CONFIG.runTokenSecret,
    );
    const runToken = deps.secrets.seal(token, runId);
    const git = new CodeManagementRuntimeGitAdapter(codeManagementOver(source, shas));
    // What the product puts in the Run (run-request-builder.service.ts) and the orchestrator hands the agent (run-orchestrator.ts).
    const diff = diffForRun(await git.getPullRequestDiff({ ...orgTeam, repositoryId, repositoryName, prNumber, headSha: shas.head })).diff;
    const entryPoints = extractEntryPoints(diff.map((d) => ({ path: d.path, patch: d.patch, content: d.content })));
    const behavior = entryPoints.filter((e) => e.kind !== 'dependency_surface');

    const trace = { side, rounds: 0, tools: [], commands: [], answers: [] };
    const machine = machineFor(testCase, source);
    const env = {
        exec: async (_claimId, r) => {
            const a = machine(r.command);
            trace.commands.push({ command: r.command.slice(0, 300), exitCode: a.exitCode, recorded: a.recorded });
            return { stepId: r.stepId, exitCode: a.exitCode, stdout: a.stdout, stderr: a.stderr, truncated: false, durationMs: 5, transport: 'ok' };
        },
    };
    const gatewayUseCase = new RuntimeLlmGatewayUseCase(deps.projections, deps.budget, deps.provider, CONFIG, clock);
    const client = side === 'planner' ? createPlannerClient(PLANNER_HOST, {
        config: CONFIG, now: clock, runs: deps.projections, usage: deps.budget, git,
        runners: deps.runners, provider: deps.modelTurnProvider, receipts: new MemoryReceipts(),
        secrets: deps.secrets, canaries: deps.canaries,
    }) : undefined;
    const planner = client ? { plan: async (call) => {
        let out;
        try { out = await client.plan(call); } catch (error) {
            if (error instanceof LlmBudgetExceededError || error?.getStatus?.() === 429)
                throw Object.assign(new Error('the Run budget ran out before a plan'), { budgetExceeded: true, round: trace.rounds });
            throw error;
        }
        trace.rounds += 1;
        trace.statuses = [...(trace.statuses || []), out.status];
        return out;
    } } : undefined;
    const llm = {
        complete: async (r) => {
            const out = await gatewayUseCase.execute({ authorization: `Bearer ${deps.secrets.open(r.runToken, r.runId)}`, body: { runId: r.runId, task: r.task, messages: r.messages } });
            trace.answers.push(out.text);
            return { text: out.text, usage: out.usage };
        },
    };
    const agent = new RuntimeAgent(llm, env, planner);
    const use = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, byTask: {} };
    const started = Date.now();
    let plan;
    try {
        plan = await global.__EVAL_CASE_ALS.run(use, () =>
            traceScope.run(trace, () =>
                agent.plan({
                    runId, attempt: 1, organizationId: orgTeam.organizationId, runToken,
                    entryPoints: behavior,
                    diffSummary: diff.map((d) => `--- ${d.path}\n${d.patch}`).join('\n'),
                    files: diff.flatMap((d) => (d.content ? [{ path: d.path, content: d.content }] : [])),
                    baseClaimId: 'eval-base-claim',
                    targets: testCase.targets,
                }),
            ),
        );
    } catch (e) {
        // The planner's own cost, not infrastructure: measured as a Run with no plan.
        if (!e?.budgetExceeded) throw e;
        trace.budgetExceeded = true;
        plan = { probes: [], tests: [], claims: [], rejected: [{ reason: `plan: the agent submitted no valid plan (${e.message}, round ${e.round + 1})` }], cannotProve: [] };
    }
    // What the Run's budget counted for this side: every round's settled reservation (S-47).
    const budgetSpent = deps.budget.sum(deps.budget.rows.filter((r) => r.runId === runId));
    return { plan, trace, behavior, ms: Date.now() - started, use, budgetSpent };
}

const re = (s) => new RegExp(s);
const pathOf = (p) => String(p.probe?.spec?.path ?? p.probe?.spec?.url ?? '');
const names = (line, what) => line === what || line.startsWith(`${what}:`) || line.startsWith(`${what} `) || line.startsWith(`unmapped:${what}`);

/** What one side's plan got right on one case. */
function score(testCase, side, { plan, trace, behavior }) {
    const exp = testCase.expected;
    const probes = plan.probes;
    const detail = [];
    let routes = 0;
    let viaOk = 0;
    let viaTotal = 0;
    for (const r of exp.routes) {
        const match = probes.find((p) => re(r.entryPoint).test(p.entryPoint) && re(r.path).test(pathOf(p)));
        if (match) routes += 1;
        detail.push({ what: `route: ${r.entryPoint.replace(/^\^|\$$/g, '')} on ${r.path.replace(/^\^|\$$/g, '')}`, ok: !!match });
        if (r.via) {
            viaTotal += 1;
            const ok = !!match && match.via === r.via;
            if (ok) viaOk += 1;
            detail.push({ what: `via: ${r.via}`, ok });
        }
        if (r.compare) detail.push({ what: `compare: ${r.compare}`, ok: !!match && (match.probe.compare || []).includes(r.compare) });
    }
    const falseProbes = probes.filter((p) => !exp.allowedPaths.some((a) => re(a).test(pathOf(p))));
    detail.push({ what: 'no false probe (a route the diff does not reach)', ok: falseProbes.length === 0 });
    const scope = { mapped: behavior.filter((e) => e.kind !== 'unmapped').map((e) => e.id), unmappedFiles: unmappedFilesOf(behavior) };
    const missing = checkPlanSubmission({ probes: probes.map((p) => ({ entryPoint: p.entryPoint, ...(p.via ? { via: p.via } : {}), probe: p.probe })), cannotProve: plan.cannotProve }, scope).missing;
    detail.push({ what: 'honest uncovered: every entry point and unmapped file probed or in cannotProve', ok: missing.length === 0 });
    for (const f of exp.cannotProve) detail.push({ what: `cannotProve: ${f}`, ok: plan.cannotProve.some((c) => names(c, f)) });
    let firstValid;
    if (side === 'planner') {
        const first = trace.tools.find((t) => t.name === SUBMIT_PLAN_TOOL);
        // A diff with no entry point, or with only dependency versions moved, is planned without a model call
        // (test-planner.use-case.ts): nothing submitted, so the plan it answered is what the checks must accept.
        const noModelCall = !trace.tools.length && (trace.statuses || []).join() === 'planned';
        firstValid = noModelCall ? planProblems(checkPlanSubmission({ probes: plan.probes, tests: plan.tests, claims: plan.claims, cannotProve: plan.cannotProve }, scope)).length === 0 : !!first && first.output === 'Accepted.';
    } else {
        const answer = parsedAnswer(trace.answers[1]);
        firstValid = answer !== undefined && planProblems(checkPlanSubmission(answer, scope)).length === 0;
    }
    detail.push({ what: 'schema-valid on the first submission', ok: firstValid });
    const noPlan = plan.rejected.some((r) => /submitted no valid plan/.test(r.reason));
    return {
        hits: detail.filter((d) => d.ok).length,
        total: detail.length,
        detail,
        metrics: {
            routes, routesExpected: exp.routes.length, viaOk, viaTotal,
            falseProbes: falseProbes.length, honest: missing.length === 0, firstValid, noPlan,
        },
        plan: {
            probes: probes.map((p) => ({ entryPoint: p.entryPoint, ...(p.via ? { via: p.via } : {}), method: p.probe.spec?.method, path: pathOf(p), compare: p.probe.compare, expected: p.probe.expected })),
            cannotProve: plan.cannotProve,
            rejected: plan.rejected.map((r) => r.reason),
            missing,
        },
    };
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i], i);
            }
        }),
    );
    return out;
}

function summary(rows) {
    const measured = rows.filter((r) => !r.unmeasured);
    const sum = (k) => measured.reduce((n, r) => n + (r.metrics[k] || 0), 0);
    const count = (k) => measured.filter((r) => r.metrics[k]).length;
    const hits = measured.reduce((n, r) => n + r.hits, 0);
    const total = measured.reduce((n, r) => n + r.total, 0);
    return {
        checks: { hits, total, value: total ? hits / total : null },
        routeRecall: { hits: sum('routes'), total: sum('routesExpected') },
        via: { hits: sum('viaOk'), total: sum('viaTotal') },
        falseProbes: sum('falseProbes'),
        honest: { hits: count('honest'), total: measured.length },
        firstValid: { hits: count('firstValid'), total: measured.length },
        noPlan: count('noPlan'),
        budgetExceeded: measured.filter((r) => r.budgetExceeded).length,
        overBudget: measured.filter((r) => r.budgetSpent > CONFIG.llmBudget.perRun).length,
        maxBudgetSpent: Math.max(0, ...measured.map((r) => r.budgetSpent || 0)),
        tokens: { in: measured.reduce((n, r) => n + r.use.in, 0), out: measured.reduce((n, r) => n + r.use.out, 0), cacheRead: measured.reduce((n, r) => n + r.use.cacheRead, 0), calls: measured.reduce((n, r) => n + r.use.calls, 0) },
        ms: measured.reduce((n, r) => n + r.ms, 0),
        measured: measured.length,
        cases: rows.length,
    };
}

const frac = (x) => (x.total ? `${x.hits}/${x.total}` : 'n/a');

async function main() {
    if (!CASES.length) {
        console.error('not measured: no case selected');
        return 2;
    }
    // The org's model, routed as production routes it: a stored BYOK config read by PermissionValidationService.
    const route = orgRouteOrExit(MODEL);
    countTokens();
    const slots = permissionSlotResolver(evalPermissionService(route.storedConfig));
    const factory = new ByokRuntimeAgentRunnerFactory(slots);
    const secrets = new SealedSecretOpener(SEAL_KEY);
    const deps = {
        projections: new InMemoryRunProjectionStore(),
        budget: new MemoryBudget(),
        provider: new ByokRuntimeLlmProvider(slots),
        modelTurnProvider: new ByokRuntimeModelTurnProvider(slots),
        secrets,
        canaries: new HmacCanaryVault(canaryKeyFrom(SEAL_KEY)),
        runners: {
            forOrganization: async (orgTeam) => {
                const r = await factory.forOrganization(orgTeam);
                return r;
            },
        },
    };
    const jobs = CASES.flatMap((c) => SIDES.map((side) => ({ c, side })));
    const outcomes = await pool(jobs, CONCURRENCY, async ({ c, side }) => {
        try {
            const ran = await runSide(side, c, deps);
            const s = score(c, side, ran);
            console.log(`  ${side.padEnd(8)} ${c.id.padEnd(30)} ${s.hits}/${s.total}  probes=${s.plan.probes.length} cannotProve=${s.plan.cannotProve.length} rounds=${ran.trace.rounds} exec=${ran.trace.commands.length} ${Math.round(ran.ms / 1000)}s ${ran.use.in + ran.use.out} tok, budget ${ran.budgetSpent}${ran.trace.budgetExceeded ? ' EXHAUSTED' : ''}`);
            return {
                side, id: c.id, checks: c.checks, hits: s.hits, total: s.total, detail: s.detail, metrics: s.metrics, plan: s.plan, ms: ran.ms, use: ran.use,
                budgetSpent: ran.budgetSpent,
                budgetExceeded: !!ran.trace.budgetExceeded,
                trace: { rounds: ran.trace.rounds, statuses: ran.trace.statuses, tools: ran.trace.tools.map(({ submitted: _s, ...t }) => t), commands: ran.trace.commands },
                handed: { entryPoints: ran.behavior.map((e) => `${e.kind}:${e.id}`) },
            };
        } catch (error) {
            const message = String(error?.response?.message ?? error?.message ?? error).slice(0, 300);
            console.error(`  ${side.padEnd(8)} ${c.id}: not measured: ${message}`);
            return { side, id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true, error: message, metrics: {}, use: { in: 0, out: 0, cacheRead: 0, calls: 0 }, ms: 0 };
        }
    });
    const bySide = Object.fromEntries(SIDES.map((side) => [side, outcomes.filter((o) => o.side === side)]));
    const sums = Object.fromEntries(SIDES.map((side) => [side, summary(bySide[side])]));
    const head = SIDES[0];
    const floor = CALIBRATION.floor;
    const versions = versionsFor({ root: ROOT, selected, all: ALL, files: Object.keys(require.cache) });
    const result = {
        eval: 'runtime-test-planner',
        question: evalQuestion('evals/runtime-test-planner'),
        model: MODEL,
        plannerHost: PLANNER_HOST,
        versions,
        calibration: CALIBRATION,
        runs: 1,
        metric: { name: `plan checks right (${head})`, value: sums[head].checks.value, floor, baseline: sums.baseline && head !== 'baseline' ? sums.baseline.checks.value : null },
        cases: bySide[head].map((o) => ({ ...o, baseline: bySide.baseline?.find((b) => b.id === o.id && head !== 'baseline') ?? undefined })),
        sides: sums,
        tokens: tokensUsed(),
        infra: { errored: outcomes.filter((o) => o.unmeasured).length, total: outcomes.length },
    };

    console.log('\n| side | checks | route recall | via | false probes | honest uncovered | schema-valid 1st | no plan | budget out | tokens in/out | wall |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const side of SIDES) {
        const s = sums[side];
        console.log(`| ${side} | ${frac(s.checks)} | ${frac(s.routeRecall)} | ${frac(s.via)} | ${s.falseProbes} | ${frac(s.honest)} | ${frac(s.firstValid)} | ${s.noPlan} | ${s.budgetExceeded} | ${s.tokens.in}/${s.tokens.out} | ${Math.round(s.ms / 1000)}s |`);
    }
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (args.record && result.infra.errored === 0) {
        const { record } = require('../results/record');
        record({
            eval: 'runtime-test-planner',
            model: MODEL,
            engine: require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(),
            config: { sides: SIDES, plannerHost: PLANNER_HOST, versions, budgetPerRun: CONFIG.llmBudget.perRun },
            dataset: `runtime-plans-${CASES.length}c`,
            judge: 'auto',
            runs: 1,
            metrics: Object.fromEntries(SIDES.map((side) => [side, sums[side]])),
            ts: new Date().toISOString().slice(0, 10),
            notes: args.notes || '',
        });
    }
    const unmeasured = result.infra.errored;
    if (unmeasured > result.infra.total * 0.05) {
        console.error(`not measured: ${unmeasured} of ${result.infra.total} runs did not measure (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape: ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate) {
        if (floor === null) {
            console.error(`not measured: no floor for ${MODEL} in targets.json (calibrate from two runs, evals/README.md rule 9)`);
            return 2;
        }
        if (result.metric.value < floor) return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
