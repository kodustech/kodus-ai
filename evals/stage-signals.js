// The quality signals of the review's steps (#2114), in BigQuery
// `quality.signals`, for every stage in evals/stages.js. The quality panel's
// stages page reads them:
//
//   tests.stage.<id>                 what the stage is (what it does, its tests,
//                                    its eval) and how each of its tests came out
//                                    tonight: unit tests (evals/stage-tests.js) and
//                                    contract tests (the wiring smoke), on main.
//                                    Every stage, every night.
//   evals.stage.<id>                 its eval on the controlled set, one model,
//                                    against the floor: the nightly
//   evals.weekly.<id>.<set>.<model>  its eval on <set> for <model>, against that
//                                    model's floor: the weekly run (evals/weekly.js)
//   tests.weekly.<id>.<model>        a contract test the weekly run repeats on
//                                    every tier-0 model
//
//   node evals/stage-signals.js --tests --wiring=<results.json> [--jest=<jest.json>] --out=<rows.json>
//   node evals/stage-signals.js --nightly=<result.json> --verdict=<verdict> [--stage=<id>] --out=<rows.json>
//
// The nightly verdict comes from evals/ci-report.js for the finder,
// evals/kody-rules/nightly-verdict.js for kody-rules, and
// evals/shared/nightly-verdict.js for the rest. Writes a JSON array of rows for
// .github/actions/report-signal (`rows`). Telemetry: it never fails a job over
// a result, only over bad arguments (exit 2).
const fs = require('fs');
const path = require('path');
const { evalQuestion, signalCases, loadCatalog, catalogProblems, signalCatalog } = require('./shared/eval-result');
const { STAGES } = require('./stages');
const { costUpperBound, catalogIdFor } = require('./investigation/nightly-compare');

const NAME_PREFIX = 'evals.stage.';
const TESTS_PREFIX = 'tests.stage.';
const WEEKLY_PREFIX = 'evals.weekly.';
const WEEKLY_TESTS_PREFIX = 'tests.weekly.';

// Same mapping as the nightly's own quality signal (code-review-evals-nightly.yml).
const VERDICT_STATUS = {
    pass: 'green',
    improved: 'green',
    oscillation: 'yellow',
    ungated: 'yellow',
    regression: 'red',
    'still-red': 'red',
    infra: 'infra',
};

// Where a stage's catalog lives: `catalog.js` in the eval's folder, or the
// eval's own `catalog` (evals/shared/eval-result.js loadCatalog).
function catalogPath(stage) {
    if (!stage.eval) return null;
    return stage.eval.catalog || path.join(stage.eval.path, 'catalog.js');
}

// What the stage's eval tests, for the panel. Telemetry: a catalog that fails to
// load is reported in the row, never fails the job (the spec catches it first).
function catalogMeta(stage) {
    const file = catalogPath(stage);
    if (!file) return {};
    try {
        const entries = loadCatalog(file);
        const problems = catalogProblems(entries);
        return problems.length ? { catalog_error: problems.slice(0, 3).join('; ') } : { case_catalog: signalCatalog(entries) };
    } catch (error) {
        return { catalog_error: `${file}: ${String(error.message || error).slice(0, 160)}` };
    }
}

// A test as the panel lists it, before any result.
function describeTest(test) {
    const base = { kind: test.kind, name: test.name };
    if (test.kind === 'unit') return { ...base, specs: test.specs };
    if (test.kind === 'e2e') return { ...base, scenario: test.scenario, signal: test.signal };
    return test.weekly ? { ...base, weekly: true } : { ...base, wiring: test.wiring };
}

// The eval as the panel describes it, before any result.
function describeEval(stage) {
    const e = stage.eval;
    if (!e) return null;
    return { path: e.path, question: evalQuestion(e.path), metric: e.metric, sets: e.sets, caveat: e.caveat || null };
}

// What the stage is, carried by every one of its rows.
function stageMeta(stage) {
    // order: position in the review, so the panel lists stages as they run.
    const index = STAGES.findIndex((s) => s.id === stage.id);
    return {
        stage: stage.id,
        name: stage.name,
        group: stage.group,
        order: index >= 0 ? index + 1 : null,
        short: stage.short,
        does: stage.does,
        pipeline: stage.pipeline,
        ...(stage.note ? { note: stage.note } : {}),
    };
}

const rel = (file) => String(file).replace(/\\/g, '/').replace(/^.*?\/(?=(libs|apps|test|tests|evals|packages)\/)/, '');

// Jest's JSON report, by spec file: passed, total, and the failed tests' names.
function jestBySpec(report) {
    const out = new Map();
    for (const t of report?.testResults || []) {
        const assertions = t.assertionResults || [];
        const failed = assertions.filter((a) => a.status === 'failed').map((a) => a.fullName);
        const suiteError = t.status === 'failed' && !failed.length ? String(t.message || '').split('\n').find((l) => l.trim()) || 'the suite failed to run' : null;
        out.set(rel(t.name), {
            passed: assertions.filter((a) => a.status === 'passed').length,
            total: assertions.length,
            failed: suiteError ? [suiteError.slice(0, 200)] : failed,
        });
    }
    return out;
}

// One test's outcome tonight: pass | fail | not-run (it should have run and did
// not), or `weekly` / `elsewhere` when another job reports it.
function testResult(test, { byStep, bySpec, jestRan }) {
    const base = describeTest(test);
    if (test.kind === 'unit') {
        if (!jestRan) return { ...base, status: 'not-run', problem: 'the unit tests did not run tonight' };
        const runs = test.specs.map((spec) => ({ spec, r: bySpec.get(spec) }));
        const missing = runs.filter((x) => !x.r).map((x) => x.spec);
        const failures = runs.flatMap((x) => (x.r ? x.r.failed.map((name) => ({ spec: x.spec, test: name })) : []));
        const passed = runs.reduce((n, x) => n + (x.r?.passed || 0), 0);
        const total = runs.reduce((n, x) => n + (x.r?.total || 0), 0);
        const status = failures.length ? 'fail' : missing.length ? 'not-run' : 'pass';
        return {
            ...base,
            status,
            passed,
            total,
            ...(failures.length ? { failures: failures.slice(0, 8) } : {}),
            ...(missing.length ? { problem: `did not run: ${missing.join(', ')}` } : {}),
        };
    }
    if (test.kind === 'e2e') return { ...base, status: 'elsewhere' };
    if (test.weekly) return { ...base, status: 'weekly' };
    const steps = test.wiring.map((step) => ({ step, r: byStep.get(step) }));
    const failed = steps.filter((x) => x.r && !x.r.ok);
    const missing = steps.filter((x) => !x.r).map((x) => x.step);
    if (failed.length) return { ...base, status: 'fail', problem: failed.map((x) => `${x.step}: ${x.r.problem}`).join('; ') };
    if (missing.length) return { ...base, status: 'not-run', problem: `did not run: ${missing.join(', ')}` };
    return { ...base, status: 'pass', ms: steps.reduce((n, x) => n + (x.r.ms || 0), 0) };
}

// tests.stage.<id>: every stage, every night, from the wiring smoke and the unit run.
function testRows({ wiring, jest } = {}, stages = STAGES) {
    const byStep = new Map((wiring || []).map((r) => [r.step, r]));
    const bySpec = jestBySpec(jest);
    // A failed entry no stage claims (the smoke's own trace check) fails the whole
    // smoke, so a stage whose steps all passed cannot be trusted that night.
    const claimed = new Set(stages.flatMap((s) => s.tests.flatMap((t) => t.wiring || [])));
    const harness = (wiring || []).filter((r) => !claimed.has(r.step) && !r.ok);
    const harnessReason = harness.length ? `wiring smoke failed: ${harness.map((r) => `${r.step}: ${r.problem}`).join('; ')}` : null;
    return stages.map((stage) => {
        const tests = stage.tests.map((t) => testResult(t, { byStep, bySpec, jestRan: Boolean(jest) }));
        const failed = tests.filter((t) => t.status === 'fail');
        const notRun = tests.filter((t) => t.status === 'not-run');
        const status = failed.length ? 'red' : notRun.length || harnessReason ? 'infra' : 'green';
        const reason = failed.length
            ? failed.map((t) => `${t.name}: ${t.problem || t.failures.map((f) => f.test).join('; ')}`).join(' · ')
            : notRun.length
              ? notRun.map((t) => `${t.name}: ${t.problem}`).join(' · ')
              : harnessReason;
        const runnable = tests.filter((t) => ['pass', 'fail', 'not-run'].includes(t.status));
        return {
            name: TESTS_PREFIX + stage.id,
            status,
            value: runnable.filter((t) => t.status === 'pass').length,
            unit: 'count',
            meta: {
                ...stageMeta(stage),
                eval: describeEval(stage),
                tests,
                ...(reason ? { reason } : {}),
                ...(harnessReason ? { harness: harnessReason } : {}),
                ...catalogMeta(stage),
            },
        };
    });
}

// The finder's cases name the PR they review; its result only carries the id.
let finderTitles = null;
function finderTitle(caseId) {
    if (!finderTitles) {
        finderTitles = new Map();
        const dir = path.join(__dirname, 'investigation', 'datasets');
        for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
                for (const test of Array.isArray(data) ? data : [data]) if (test?.vars?.caseId) finderTitles.set(test.vars.caseId, test.vars.prTitle || null);
            } catch {
                // a dataset that does not parse only loses its title here
            }
        }
    }
    return finderTitles.get(caseId) || caseId;
}

// The finder's rows (run-recall.js) as cases of the shared result shape
// (evals/shared/eval-result.js): the known bugs of each PR, found or not.
function finderCases(rows = []) {
    return rows.map((row) => {
        const m = row.metadata || {};
        const checks = `Finds the known bugs in "${finderTitle(row.caseId)}"`;
        if (!Number.isInteger(m.goldens)) return { id: row.caseId, checks, hits: 0, total: 0, unmeasured: true };
        // Counted from the bugs shown, never from `matched`: on a confirmed night
        // confirm-gate.js marks a bug found when either run found it but keeps
        // the first run's `matched`, and the two would disagree.
        const detail = (m.goldenResults || []).map((g) => ({ what: g.golden, ok: Boolean(g.found) }));
        if (!detail.length) return { id: row.caseId, checks, hits: m.matched ?? 0, total: m.goldens };
        return { id: row.caseId, checks, hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
    });
}

// What the stage's model calls cost, for the panel: totals, per-call time
// percentiles, and per case (one review of one case: cases × runs). The raw
// per-call times stay in the result file, out of BigQuery. $ is the Kodus
// catalog price with every input token at the full rate (cached ones too), so
// it is an upper bound, and only for models the catalog sells; null otherwise.
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
function usageMeta(tokens, reviews, model) {
    if (!tokens || typeof tokens !== 'object') return null;
    const n = (k) => (Number.isFinite(tokens[k]) ? tokens[k] : 0);
    const callMs = Array.isArray(tokens.callMs) ? [...tokens.callMs].sort((x, y) => x - y) : [];
    const per = (v) => (reviews > 0 ? v / reviews : null);
    const usd = costUpperBound({ prompt: n('in'), completion: n('out') }, catalogIdFor(model));
    return {
        calls: n('calls'),
        in: n('in'),
        out: n('out'),
        cacheRead: n('cacheRead'),
        cacheWrite: n('cacheWrite'),
        // `in` counts the cached tokens too (eval-kit.js tokensUsed).
        cacheHit: n('in') > 0 ? n('cacheRead') / n('in') : null,
        ms: n('ms'),
        p50Ms: percentile(callMs, 0.5),
        p95Ms: percentile(callMs, 0.95),
        reviews: reviews || null,
        perCase: reviews > 0 ? { calls: per(n('calls')), in: per(n('in')), out: per(n('out')), cacheRead: per(n('cacheRead')), cacheWrite: per(n('cacheWrite')), ms: per(n('ms')) } : null,
        usdPerCaseMax: typeof usd === 'number' && reviews > 0 ? usd / reviews : null,
    };
}

// The token totals as the row carried them before usage: without the per-call times.
const tokensMeta = (tokens) => (tokens ? Object.fromEntries(Object.entries(tokens).filter(([k]) => k !== 'callMs')) : null);

// How each eval's result is read: the number, its floor, the level it usually
// sits at, what each case checked, and what else the panel shows.
const READERS = {
    // evals/investigation/run-recall.js (after confirm-gate.js)
    'finder-recall': (r) => {
        const check = (r.gate?.checks || []).find((c) => c.name === 'recall_mean');
        return {
            value: r.metrics?.recall_mean,
            floor: check?.floor ?? null,
            baseline: r.gate?.observed?.recall_mean ?? null,
            extra: {
                precision: r.metrics?.precision_mean ?? null,
                model: r.model || null,
                cases: r.cases ?? null,
                unmeasured: r.unmeasured ?? null,
                // A confirmed night pools two runs of every case (confirm-gate.js).
                usage: usageMeta(r.usage, (r.cases || 0) * (r.gate?.confirmation ? 2 : 1), r.model),
                case_results: signalCases(finderCases(r.rows)),
            },
        };
    },
    // Any eval of evals/nightly-evals.js: the shared result, after
    // evals/shared/nightly-verdict.js.
    shared: (r) => ({
        value: r.metric?.value,
        floor: r.metric?.floor ?? null,
        baseline: r.metric?.baseline ?? null,
        extra: {
            // A number measured beside the gated one, never gated (evals/thread-actions).
            ...(r.reported ? { reported: { name: r.reported.name, value: r.reported.value ?? null } } : {}),
            model: r.model || null,
            cases: Array.isArray(r.cases) ? r.cases.length : null,
            runs: r.runs ?? null,
            tokens: tokensMeta(r.tokens),
            usage: usageMeta(r.tokens, (Array.isArray(r.cases) ? r.cases.length : 0) * (r.runs || 1), r.model),
            case_results: signalCases(r.cases),
        },
    }),
    // evals/kody-rules/real-agent.js --output (after nightly-verdict.js): the shared shape
    'kody-rules': (r) => ({
        value: r.metric?.value,
        floor: r.metric?.floor ?? null,
        baseline: r.metric?.baseline ?? null,
        extra: {
            specificity: r.specificity?.value ?? null,
            specificity_floor: r.specificity?.floor ?? null,
            line_precision: r.linePrecision ?? null,
            model: r.model || null,
            cases: Array.isArray(r.cases) ? r.cases.length : null,
            sites: r.counts?.sites ?? null,
            runs: r.runs ?? null,
            tokens: tokensMeta(r.tokens),
            usage: usageMeta(r.tokens, (Array.isArray(r.cases) ? r.cases.length : 0) * (r.runs || 1), r.model),
            case_results: signalCases(r.cases),
        },
    }),
};

// A model id inside a signal name, folded as .github/actions/report-signal does
// ([a-z0-9._-]); the row's meta keeps the id itself.
const nameOf = (model) => String(model).toLowerCase().replace(/[^a-z0-9._-]+/g, '_');

// Why a model has no floor on a stage's eval, when its targets file says so: a `noFloor`
// sentence beside the measure (models.<model>, sets.<set>.models.<model>, and for one eval
// measuring two stages, the stage's kind under it).
function noFloorReason(stage, model, set) {
    if (!stage.eval || !model) return null;
    let t;
    try {
        t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', stage.eval.path, 'targets.json'), 'utf8'));
    } catch {
        return null;
    }
    const kind = stage.id.startsWith('thread-') ? stage.id.slice('thread-'.length) : null;
    for (const scope of [t.sets?.[set]?.models, set === 'controlled' ? t.models : null]) {
        const entry = scope?.[model];
        const at = kind && entry?.[kind] ? entry[kind] : entry;
        if (typeof at?.noFloor === 'string') return at.noFloor;
    }
    return null;
}

// One eval result as a row: its number against its floor, status from the verdict.
function evalRow(name, stage, result, verdict, extraMeta) {
    const meta = { ...stageMeta(stage), eval: describeEval(stage), ...extraMeta };
    const read = result ? READERS[stage.eval.nightly](result) : null;
    if (!read || !Number.isFinite(read.value)) {
        return { name, status: 'infra', value: null, unit: 'ratio', meta: { ...meta, reason: result ? 'the result has no value' : 'no result' } };
    }
    const noFloor = read.floor === null ? noFloorReason(stage, read.extra.model || extraMeta.model, extraMeta.set) : null;
    return {
        name,
        status: VERDICT_STATUS[verdict] || 'infra',
        value: read.value,
        unit: 'ratio',
        meta: { ...meta, floor: read.floor, baseline: read.baseline, ...read.extra, verdict: verdict || null, ...(noFloor ? { no_floor: noFloor } : {}) },
    };
}

// evals.stage.<id>: the nightly's measure of one stage (default finder).
function nightlyRows(result, verdict, stageId = 'finder', stages = STAGES) {
    return stages
        .filter((stage) => stage.eval && stage.id === stageId)
        .map((stage) => evalRow(NAME_PREFIX + stage.id, stage, result, verdict, { tier: 'nightly', set: 'controlled' }));
}

// evals.weekly.<id>.<set>.<model>: the weekly run's measure of one stage on one model.
function weeklyRows(result, verdict, { stageId, model, set }, stages = STAGES) {
    return stages
        .filter((stage) => stage.eval && stage.id === stageId)
        .map((stage) => {
            const row = evalRow(`${WEEKLY_PREFIX}${stage.id}.${set}.${nameOf(model)}`, stage, result, verdict, { tier: 'weekly', set, model });
            // Only the outcome per case: the panel's matrix needs the number, the
            // floor and the cost; the cases stay in the run's artifact.
            const { case_catalog: _catalog, ...meta } = row.meta;
            return { ...row, meta };
        });
}

// tests.weekly.<id>.<model>: a contract test the weekly run repeats on a model.
function weeklyTestRows({ stageId, model, exit, problem }, stages = STAGES) {
    const stage = stages.find((s) => s.id === stageId);
    const test = stage?.tests.find((t) => t.weekly);
    if (!test) return [];
    const status = exit === 0 ? 'green' : exit === 1 ? 'red' : 'infra';
    return [
        {
            name: `${WEEKLY_TESTS_PREFIX}${stage.id}.${nameOf(model)}`,
            status,
            value: null,
            unit: null,
            meta: { stage: stage.id, name: stage.name, test: test.name, kind: test.kind, tier: 'weekly', model, ...(problem ? { reason: problem } : {}) },
        },
    ];
}

function arg(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function main() {
    const out = arg('out');
    const tests = process.argv.includes('--tests');
    const nightly = arg('nightly');
    if (!out || (!tests && !nightly)) {
        console.error('usage: stage-signals.js (--tests --wiring=<results.json> [--jest=<jest.json>] | --nightly=<result.json> --verdict=<v> [--stage=<id>]) --out=<rows.json>');
        return 2;
    }
    const rows = tests
        ? testRows({ wiring: readJson(arg('wiring')), jest: arg('jest') ? readJson(arg('jest')) : null })
        : nightlyRows(readJson(nightly), arg('verdict'), arg('stage') || 'finder');
    fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    for (const row of rows) console.log(`${row.status.padEnd(7)} ${row.name}${row.value === null ? '' : ` = ${row.value}`}`);
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { testRows, nightlyRows, weeklyRows, weeklyTestRows, READERS, NAME_PREFIX, TESTS_PREFIX, WEEKLY_PREFIX, WEEKLY_TESTS_PREFIX, VERDICT_STATUS, catalogPath, usageMeta, jestBySpec };
