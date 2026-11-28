#!/usr/bin/env node
// runtime-intent: Kody Runtime's intent classifier (docs §4, ADR-007) on
// findings whose right intent is known, at a reasoning effort chosen per run.
//
// Each case is one finding a replay measured (main and the PR differ) with the
// pull request it came from. The eval runs production's classifyIntents with
// production's IntentClassifier (apps/runtime/src/worker/intent/intent-classifier.ts):
// its prompt, its parse and its guard (`intended` only with a pre-existing test
// that passed on both sides). The classifier's LlmGateway calls
// RuntimeLlmGatewayUseCase.execute (POST /internal/runtime/llm, minus HTTP),
// which calls ByokRuntimeLlmProvider → LLM.run on the org's LLM_TASK.runtime slot.
// The eval supplies data only: the finding, the PR's title, description and
// diff, the test outcomes, the Run projection, a budget store in memory and
// the org's stored BYOK config (evals/shared/model-route.js).
//
//   node evals/runtime-intent/run.js [--model=<id>] [--effort=slot|none|low|medium|high]
//        [--reps=N] [--concurrency=N] [--cases=<id,...>] [--output=<result.json>] [--record]
//
// --effort=slot stores no effort in the slot (what an org that never picked one
// runs); any other value is stored in the slot as the org's own choice.
// Exit: 0 measured, 2 did not measure (evals/README.md). No floor yet.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = path.join(__dirname, '..', '..');
// The keys the evals read: the repository's env files and ~/.kodus-dev/config (as evals/runtime-test-planner does).
const dotenv = require('dotenv');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
dotenv.config({ path: path.join(ROOT, '.env.local'), override: true, quiet: true });
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true, quiet: true });
// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
process.env.API_LOG_LEVEL = process.env.EVAL_LOG_LEVEL || 'warn';

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-pro';
const EFFORT = String(args.effort || 'slot');
if (!['slot', 'none', 'low', 'medium', 'high'].includes(EFFORT)) {
    console.error(`not measured: unknown --effort=${EFFORT}`);
    process.exit(2);
}
// The slot's own effort, as the org stores it (model-route.js reads it from here).
if (EFFORT === 'slot') delete process.env.RECALL_REASONING_EFFORT;
else process.env.RECALL_REASONING_EFFORT = EFFORT;
const REPS = Math.max(1, Number(args.reps) || 3);
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 4);
const CASES = require('./cases.json').filter((c) => (args.cases ? String(args.cases).split(',').includes(c.id) : true));

const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const engine = (p) => require(path.join(ROOT, p));
const { RuntimeLlmGatewayUseCase } = engine('libs/runtime/api/application/use-cases/llm-gateway.use-case.ts');
const { ByokRuntimeLlmProvider, permissionSlotResolver } = engine('libs/runtime/api/infrastructure/byok-runtime-llm.provider.ts');
const { loadRuntimeApiConfig } = engine('libs/runtime/api/infrastructure/runtime-api.config.ts');
const { signRunToken } = engine('libs/runtime/api/domain/run-token.ts');
const { InMemoryRunProjectionStore } = engine('libs/runtime/run/testing/in-memory-run-projection.store.ts');
const { IntentClassifier, classifyIntents } = engine('apps/runtime/src/worker/intent/intent-classifier.ts');

const CONFIG = loadRuntimeApiConfig({ RUNTIME_RUN_TOKEN_SECRET: crypto.randomBytes(32).toString('hex') });
const clock = () => new Date();

/** The Run's LLM budget, in memory (the Mongo store's reserve/settle contract). */
class MemoryBudget {
    rows = [];
    seq = 0;
    sum = (rows) => rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    async reserve({ usage, orgDayStart, decide }) {
        const tokens = decide({
            run: this.sum(this.rows.filter((r) => r.runId === usage.runId)),
            pullRequest: this.sum(this.rows.filter((r) => r.runId === usage.runId)),
            orgToday: 0,
        });
        if (tokens === null) return null;
        const id = `res-${++this.seq}`;
        this.rows.push({ ...usage, inputTokens: tokens, outputTokens: 0, id, at: orgDayStart });
        return { reservationId: id, tokens };
    }
    async settle(id, actual) {
        const row = this.rows.find((r) => r.id === id);
        if (row) Object.assign(row, actual);
    }
    async cancel(id) {
        this.rows = this.rows.filter((r) => r.id !== id);
    }
}

// Per call: the model's raw answer and the gateway's time (read by wrapping, never replacing).
const callScope = new AsyncLocalStorage();

/** What the model itself proposed, before the classifier's guard (the classifier's own reading: first JSON object). */
function proposed(text) {
    const m = /\{[\s\S]*\}/.exec(text || '');
    if (!m) return null;
    try {
        return JSON.parse(m[0])?.intent ?? null;
    } catch {
        return null;
    }
}

async function runCase(testCase, rep, deps) {
    const runId = crypto.randomUUID();
    const orgTeam = { organizationId: EVAL_ORG.organizationId, teamId: EVAL_ORG.teamId };
    const repositoryId = `eval-intent-${testCase.id}`;
    const now = clock();
    await deps.projections.upsert(runId, {
        runId, attempt: 1, correlationId: `eval-${runId}`, ...orgTeam, repositoryId, repositoryName: `eval/${testCase.id}`, prNumber: 1,
        headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), environmentId: 'eval-env', imageId: 'eval-image', state: 'testing',
        requestedAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    const runToken = signRunToken(
        { runId, attempt: 1, ...orgTeam, repositoryId, prNumber: 1, maxTokens: CONFIG.llmBudget.perRun, exp: Math.floor(now.getTime() / 1000) + 3_600 },
        CONFIG.runTokenSecret,
    );
    const call = { text: null, ms: null, usage: null, decision: null };
    const verdicts = await callScope.run(call, () =>
        classifyIntents({
            verdicts: [testCase.finding],
            // What run-orchestrator.ts hands the classifier.
            ctx: { runId, organizationId: orgTeam.organizationId, runToken, diff: testCase.diff, title: testCase.pullRequest.title, description: testCase.pullRequest.description, tests: testCase.tests },
            classifier: deps.classifier,
            step: (_name, fn) => fn(),
        }),
    );
    const final = verdicts[0].intent;
    const accept = testCase.accept || [testCase.expected];
    return {
        id: testCase.id,
        rep,
        final,
        proposed: proposed(call.text),
        exact: final === testCase.expected,
        // What ships: only `intended` changes the Run's conclusion and the comment (run-state.ts, render-runtime-comment.ts).
        shipped: (final === 'intended') === (testCase.expected === 'intended'),
        acceptable: accept.includes(final),
        reason: call.decision?.reason,
        unmeasured: !call.text && /intent classifier unavailable/.test(call.decision?.reason || '') ? call.decision.reason : null,
        ms: call.ms,
        usage: call.usage,
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

const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
    if (!CASES.length) {
        console.error('not measured: no case selected');
        return 2;
    }
    const route = orgRouteOrExit(MODEL);
    countTokens();
    const slots = permissionSlotResolver(evalPermissionService(route.storedConfig));
    const projections = new InMemoryRunProjectionStore();
    const gateway = new RuntimeLlmGatewayUseCase(projections, new MemoryBudget(), new ByokRuntimeLlmProvider(slots), CONFIG, clock);
    const llm = {
        complete: async (r) => {
            const call = callScope.getStore();
            const started = Date.now();
            const out = await gateway.execute({ authorization: `Bearer ${r.runToken}`, body: { runId: r.runId, task: r.task, messages: r.messages } });
            if (call) Object.assign(call, { text: out.text, ms: Date.now() - started, usage: out.usage });
            return { text: out.text, usage: out.usage };
        },
    };
    const inner = new IntentClassifier(llm);
    const classifier = {
        classify: async (finding, ctx) => {
            const d = await inner.classify(finding, ctx);
            const call = callScope.getStore();
            if (call) call.decision = d;
            return d;
        },
    };
    const deps = { projections, classifier };

    const jobs = CASES.flatMap((c) => Array.from({ length: REPS }, (_, rep) => ({ c, rep })));
    const started = Date.now();
    const rows = await pool(jobs, CONCURRENCY, async ({ c, rep }) => {
        try {
            const r = await runCase(c, rep, deps);
            console.log(`  ${c.id.padEnd(30)} rep ${rep + 1}  ${String(r.final).padEnd(10)} (model: ${String(r.proposed).padEnd(10)}) expected ${c.expected.padEnd(10)} ${r.exact ? 'ok ' : r.acceptable ? '~  ' : 'MISS'} ${r.ms ?? '-'} ms ${r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens} tok` : ''}${r.unmeasured ? ` NOT MEASURED: ${r.unmeasured}` : ''}`);
            return r;
        } catch (error) {
            const message = String(error?.response?.message ?? error?.message ?? error).slice(0, 300);
            console.error(`  ${c.id} rep ${rep + 1}: not measured: ${message}`);
            return { id: c.id, rep, unmeasured: message };
        }
    });
    const wall = Date.now() - started;
    const measured = rows.filter((r) => !r.unmeasured);
    const ms = measured.map((r) => r.ms).filter(Number.isFinite);
    const ins = measured.map((r) => r.usage?.inputTokens ?? 0);
    const outs = measured.map((r) => r.usage?.outputTokens ?? 0);
    const cases = CASES.map((c) => {
        const mine = measured.filter((r) => r.id === c.id);
        return {
            id: c.id,
            checks: c.checks,
            expected: c.expected,
            hits: mine.filter((r) => r.exact).length,
            total: mine.length,
            acceptable: mine.filter((r) => r.acceptable).length,
            labels: mine.map((r) => r.final),
            proposed: mine.map((r) => r.proposed),
            stable: new Set(mine.map((r) => r.final)).size <= 1,
            ms: mine.map((r) => r.ms),
            detail: mine.map((r) => ({ what: `rep ${r.rep + 1}: ${r.final} (model ${r.proposed}), expected ${c.expected}`, ok: r.exact })),
        };
    });
    const exact = measured.filter((r) => r.exact).length;
    const summary = {
        effort: EFFORT,
        wireEfforts: tokensUsed().efforts['runtime.intent'] || [],
        exact: { hits: exact, total: measured.length },
        acceptable: { hits: measured.filter((r) => r.acceptable).length, total: measured.length },
        shipped: { hits: measured.filter((r) => r.shipped).length, total: measured.length },
        stableCases: { hits: cases.filter((c) => c.stable).length, total: cases.length },
        rawIntendedWithoutEvidence: measured.filter((r) => r.proposed === 'intended' && r.final !== 'intended').length,
        latencyMs: { p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null },
        tokensPerCall: { in: ins.length ? Math.round(ins.reduce((a, b) => a + b, 0) / ins.length) : 0, out: outs.length ? Math.round(outs.reduce((a, b) => a + b, 0) / outs.length) : 0, outP95: pct(outs, 95) },
        wallMs: wall,
        unmeasured: rows.length - measured.length,
    };
    const result = {
        eval: 'runtime-intent',
        question: evalQuestion('evals/runtime-intent'),
        model: MODEL,
        runs: REPS,
        metric: { name: 'intent decisions right (exact)', value: measured.length ? exact / measured.length : null, floor: null },
        config: { effort: EFFORT, reps: REPS, concurrency: CONCURRENCY },
        summary,
        cases,
        tokens: tokensUsed(),
        infra: { errored: rows.length - measured.length, total: rows.length },
    };

    console.log('\n| model | effort | wire | shipped | exact | acceptable | stable cases | p50 | p95 | max | tokens in/out per call | wall |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    const s = summary;
    console.log(`| ${MODEL} | ${EFFORT} | ${s.wireEfforts.join(', ') || 'n/a'} | ${s.shipped.hits}/${s.shipped.total} | ${s.exact.hits}/${s.exact.total} | ${s.acceptable.hits}/${s.acceptable.total} | ${s.stableCases.hits}/${s.stableCases.total} | ${(s.latencyMs.p50 / 1000).toFixed(1)} s | ${(s.latencyMs.p95 / 1000).toFixed(1)} s | ${(s.latencyMs.max / 1000).toFixed(1)} s | ${s.tokensPerCall.in}/${s.tokensPerCall.out} | ${Math.round(wall / 1000)} s |`);

    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (args.record && result.infra.errored === 0) {
        const { record } = require('../results/record');
        record({
            eval: 'runtime-intent',
            model: MODEL,
            engine: require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(),
            config: result.config,
            dataset: `runtime-intent-${CASES.length}c`,
            judge: 'auto',
            runs: REPS,
            metrics: summary,
            ts: new Date().toISOString().slice(0, 10),
            notes: args.notes || '',
        });
    }
    if (result.infra.errored > result.infra.total * 0.05) {
        console.error(`not measured: ${result.infra.errored} of ${result.infra.total} calls did not measure (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape: ${problems.join('; ')}`);
        return 2;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
