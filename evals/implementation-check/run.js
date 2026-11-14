#!/usr/bin/env node
// implementation-check: after a push, does the check record whether the
// developer made the change each suggestion asked for?
//
// Drives SuggestionService.checkImplementedSuggestions, the method the
// implementation-verification processor calls with the PR's saved suggestions
// and the files changed since the last review. The model is the org's code
// review route (production's PermissionValidationService over a stored BYOK
// config, evals/shared/model-route.js); the LLM service is production's. The
// eval supplies the data: the saved suggestions, the changed files, and a PR
// store that records what the check writes. A verdict is what the store holds
// for the suggestion afterwards, as the Cockpit and the next review read it.
//
//   node evals/implementation-check/run.js [--model=<id>] [--set=controlled|full]
//        [--repeats=N] [--concurrency=N] [--limit=N] [--output=<file>] [--gate]
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { registerTs, countTokens, tokensUsed } = require('../shared/eval-kit');

registerTs();
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true, quiet: true });
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true, quiet: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const MODEL = args.model || 'eval-fake';
const SET = args.set || 'controlled';
const REPEATS = Number(args.repeats || 1);
const CONCURRENCY = Number(args.concurrency || 6);
const INFRA_BUDGET = 0.05;
const TARGETS = require('./targets.json');
const floor = (TARGETS.models[MODEL] || {}).floor ?? null;
const observed = (TARGETS.models[MODEL] || {}).observed ?? null;

// Both sets are every case today; `full` is where cases from other sources go.
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);

const APPLIED = new Set(['implemented', 'partially_implemented']);
const applied = (status) => APPLIED.has(status);

// The PR store the check writes to: what it persisted, per suggestion.
function recordingStore() {
    const writes = new Map();
    const store = new Proxy(
        {},
        {
            get: (_, name) => {
                if (name === 'then') return undefined;
                if (name === 'updateSuggestion') {
                    return async (id, data) => {
                        writes.set(id, { ...(writes.get(id) || {}), ...data });
                        return null;
                    };
                }
                return async () => null;
            },
        },
    );
    return { store, writes };
}

function services(route) {
    const { SuggestionService } = require('../../libs/code-review/infrastructure/adapters/services/suggestion.service.ts');
    const { LLMAnalysisService } = require('../../libs/code-review/infrastructure/adapters/services/llmAnalysis.service.ts');
    const permissionValidationService = evalPermissionService(route.storedConfig);
    const aiAnalysisService = new LLMAnalysisService(null, null);
    return (store) => new SuggestionService(aiAnalysisService, store, null, null, null, permissionValidationService);
}

// One run of one case: what the store holds for each suggestion afterwards.
async function runCase(testCase, makeService) {
    const { store, writes } = recordingStore();
    const service = makeService(store);
    const suggestions = JSON.parse(JSON.stringify(testCase.suggestions));
    await service.checkImplementedSuggestions({
        organizationAndTeamData: EVAL_ORG,
        prNumber: 1,
        changedFiles: testCase.changedFiles,
        savedSuggestions: suggestions,
    });
    // A suggestion the check leaves alone keeps its status, and that status is
    // the verdict the Cockpit reads; only a check that records an unmeasured
    // outcome takes it out of the score.
    return suggestions.map((s) => {
        const written = writes.get(s.id) || {};
        // A grouped suggestion's record is written field by field.
        const outcome = written.implementationCheck?.outcome ?? written['implementationCheck.outcome'];
        const unmeasured = outcome === 'unmeasured';
        const stored = written.implementationStatus !== undefined ? written.implementationStatus : s.implementationStatus;
        return { id: s.id, stored, unmeasured, expected: testCase.expected[s.id] };
    });
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

function caseResult(testCase, runs) {
    const verdicts = runs.flatMap((r) => r.verdicts || []);
    const measured = verdicts.filter((v) => !v.unmeasured);
    const right = measured.filter((v) => applied(v.stored) === applied(v.expected));
    const exact = measured.filter((v) => v.stored === v.expected);
    const markedApplied = measured.filter((v) => applied(v.stored));
    const truthApplied = measured.filter((v) => applied(v.expected));
    return {
        id: testCase.id,
        checks: testCase.checks.length > 160 ? `${testCase.checks.slice(0, 159)}…` : testCase.checks,
        hits: right.length,
        total: measured.length,
        exact: exact.length,
        markedApplied: markedApplied.length,
        markedAppliedRight: markedApplied.filter((v) => applied(v.expected)).length,
        truthApplied: truthApplied.length,
        truthAppliedFound: truthApplied.filter((v) => applied(v.stored)).length,
        unmeasuredVerdicts: verdicts.length - measured.length,
        stored: verdicts.map((v) => `${v.id.replace(/^sugg-/, '')}=${v.unmeasured ? 'unmeasured' : String(v.stored)}`).join(' '),
        ...(measured.length ? {} : { unmeasured: true }),
    };
}

const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null);

async function main() {
    const route = orgRouteOrExit(MODEL);
    const makeService = services(route);
    countTokens();
    console.error(`implementation-check: ${cases.length} cases x ${REPEATS} on ${MODEL}`);

    const jobs = cases.flatMap((c) => Array.from({ length: REPEATS }, (_, repeat) => ({ c, repeat })));
    const runs = await mapLimit(jobs, CONCURRENCY, async ({ c, repeat }) => {
        try {
            return { id: c.id, repeat, verdicts: await runCase(c, makeService) };
        } catch (error) {
            return { id: c.id, repeat, error: String(error?.message || error).slice(0, 200) };
        }
    });

    const results = cases.map((c) => caseResult(c, runs.filter((r) => r.id === c.id)));
    const sum = (key) => results.reduce((n, r) => n + (r[key] || 0), 0);
    const verdictsTotal = sum('total') + sum('unmeasuredVerdicts');
    const errored = runs.filter((r) => r.error);
    const notMeasured = sum('unmeasuredVerdicts') + errored.reduce((n, r) => n + (cases.find((c) => c.id === r.id)?.suggestions.length || 0), 0);
    const allVerdicts = verdictsTotal + errored.reduce((n, r) => n + (cases.find((c) => c.id === r.id)?.suggestions.length || 0), 0);

    const result = {
        eval: 'implementation-check',
        question: evalQuestion('evals/implementation-check'),
        model: MODEL,
        set: SET,
        runs: REPEATS,
        // Under the scripted model every verdict can be unmeasured (see the budget below).
        metric: { name: 'of verdicts right (applied or not)', value: ratio(sum('hits'), sum('total')) ?? (MODEL === 'eval-fake' ? 0 : null), floor, baseline: observed },
        appliedPrecision: ratio(sum('markedAppliedRight'), sum('markedApplied')),
        appliedRecall: ratio(sum('truthAppliedFound'), sum('truthApplied')),
        exactStatus: ratio(sum('exact'), sum('total')),
        unmeasuredShare: ratio(notMeasured, allVerdicts),
        cases: results,
        tokens: tokensUsed(),
        infra: { errored: errored.length, total: runs.length, unmeasuredVerdicts: notMeasured, verdicts: allVerdicts },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(String(args.output))), { recursive: true });
        fs.writeFileSync(String(args.output), `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(JSON.stringify({ ...result, cases: undefined }, null, 2));
    for (const r of results.filter((x) => x.hits < x.total || x.unmeasured)) console.error(`  ✗ ${r.id}: ${r.stored}`);
    for (const r of errored.slice(0, 5)) console.error(`  ! ${r.id}#${r.repeat}: ${r.error}`);

    // The scripted model answers with ids of its own, so the check rightly
    // leaves every verdict unmeasured: the wiring smoke needs the calls, not
    // the verdicts.
    if (MODEL !== 'eval-fake' && notMeasured > allVerdicts * INFRA_BUDGET) {
        console.error(`not measured: ${notMeasured} of ${allVerdicts} verdicts did not measure (budget ${Math.floor(allVerdicts * INFRA_BUDGET)})`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && floor === null) {
        console.error(`not measured: no floor for ${MODEL} in evals/implementation-check/targets.json`);
        return 2;
    }
    if (args.gate && result.metric.value < floor) {
        console.error(`below the floor: ${(result.metric.value * 100).toFixed(1)}% < ${(floor * 100).toFixed(1)}%`);
        return 1;
    }
    return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });
