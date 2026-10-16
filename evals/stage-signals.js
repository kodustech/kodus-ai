// One quality signal per review stage (#2114): `evals.stage.<id>` in BigQuery
// `quality.signals`, for every stage in evals/stages.js, so the quality panel
// lists each stage with its eval, or `none`.
//
//   node evals/stage-signals.js --wiring=<results.json> --out=<rows.json>
//       results from `evals/wiring-smoke.js --results`. Every stage except the
//       nightly-measured ones: green or red from its wiring steps, infra when a
//       step did not run, skipped for a stage the wiring smoke does not run
//       (meta.measured says how it is checked: unit suite, E2E matrix, by hand, or not).
//   node evals/stage-signals.js --nightly=<result.json> --verdict=<verdict> [--stage=<id>] --out=<rows.json>
//       one nightly-measured stage (default finder): its number against its
//       floor, status from the nightly verdict (evals/ci-report.js for the
//       finder, evals/kody-rules/nightly-verdict.js for kody-rules).
//
// Writes a JSON array of rows for .github/actions/report-signal (`rows`). Telemetry:
// it never fails a job over a result, only over bad arguments (exit 2).
const fs = require('fs');
const path = require('path');
const { evalQuestion, signalCases, loadCatalog, catalogProblems, signalCatalog } = require('./shared/eval-result');
const { STAGES } = require('./stages');
const { tier0 } = require('./shared/tier0-models');
const { costUpperBound, catalogIdFor } = require('./investigation/nightly-compare');

const NAME_PREFIX = 'evals.stage.';

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

// The Friday check runs these stages on every tier-0 model and only proves they
// still run there. Its per-model result is `evals.tier0.<model>`; `result` is
// the key of this stage's outcome in that row's meta.
function fridayMeta(stage) {
    return stage.friday ? { friday: { models: tier0(), result: stage.friday } } : {};
}

// Where a stage's catalog lives: `catalog.js` in the eval's folder under
// evals/, or `evals/catalogs/<stage id>.js` for an eval that lives elsewhere
// (a unit-suite test, an E2E scenario, one script inside another eval).
function catalogPath(stage) {
    if (!stage.eval) return null;
    const abs = path.join(__dirname, '..', stage.eval);
    const ownFolder = stage.eval.startsWith('evals/') && fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    return ownFolder ? path.join(stage.eval, 'catalog.js') : path.join('evals', 'catalogs', `${stage.id}.js`);
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

function baseMeta(stage) {
    // order: position in the review, so the panel lists stages as they run.
    const index = STAGES.findIndex((s) => s.id === stage.id);
    return {
        stage: stage.label,
        question: evalQuestion(stage.eval),
        name: stage.name,
        group: stage.group,
        order: index >= 0 ? index + 1 : null,
        eval: stage.eval,
        measured: stage.model,
        wiring: stage.wiring,
        note: stage.note,
        by_hand: stage.byHand || [],
        ...(stage.metric ? { metric: stage.metric, set: stage.set } : {}),
        ...(stage.caveat ? { caveat: stage.caveat } : {}),
        ...(stage.history ? { history: stage.history } : {}),
        ...fridayMeta(stage),
        ...catalogMeta(stage),
    };
}

function wiringRows(results, stages = STAGES) {
    const byStep = new Map((results || []).map((r) => [r.step, r]));
    // A failed entry no stage claims (the smoke's own trace check) fails the whole
    // smoke, so a wired stage whose steps all passed cannot be trusted that night.
    // A stage's own failure still reports red: it is the actionable signal.
    const claimed = new Set(stages.flatMap((stage) => stage.wiring));
    const harness = (results || []).filter((r) => !claimed.has(r.step) && !r.ok);
    const harnessReason = harness.length ? `wiring smoke failed: ${harness.map((r) => `${r.step}: ${r.problem}`).join('; ')}` : null;
    const withHarness = (meta) => (harnessReason ? { ...meta, harness: harnessReason } : meta);
    return stages
        .filter((stage) => !stage.nightly)
        .map((stage) => {
            const meta = baseMeta(stage);
            if (!stage.wiring.length) {
                // Not run by the wiring smoke. Its eval may still run elsewhere on a
                // schedule (unit suite, E2E matrix): meta.measured says which.
                return { name: NAME_PREFIX + stage.id, status: 'skipped', value: null, unit: null, meta };
            }
            const failed = stage.wiring.map((step) => byStep.get(step)).filter((r) => r && !r.ok);
            if (failed.length) {
                return {
                    name: NAME_PREFIX + stage.id,
                    status: 'red',
                    value: null,
                    unit: null,
                    meta: withHarness({ ...meta, reason: failed.map((r) => `${r.step}: ${r.problem}`).join('; '), failed: failed.map((r) => r.step) }),
                };
            }
            const missing = stage.wiring.filter((step) => !byStep.has(step));
            if (missing.length) {
                return {
                    name: NAME_PREFIX + stage.id,
                    status: 'infra',
                    value: null,
                    unit: null,
                    meta: withHarness({ ...meta, reason: `wiring step(s) did not run: ${missing.join(', ')}` }),
                };
            }
            if (harnessReason) {
                return { name: NAME_PREFIX + stage.id, status: 'infra', value: null, unit: null, meta: withHarness({ ...meta, reason: harnessReason }) };
            }
            return { name: NAME_PREFIX + stage.id, status: 'green', value: null, unit: null, meta };
        });
}

// How each nightly-measured stage reads its result: the number, its floor, the
// level it usually sits at, and what else the panel shows.
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

// How each nightly-measured stage reads its result: the number, its floor, the
// level it usually sits at, what each case checked, and what else the panel shows.
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

function nightlyRows(result, verdict, stageId = 'finder', stages = STAGES) {
    return stages
        .filter((stage) => stage.nightly && stage.id === stageId)
        .map((stage) => {
            const meta = baseMeta(stage);
            const read = result ? READERS[stage.nightly](result) : null;
            if (!read || !Number.isFinite(read.value)) {
                return {
                    name: NAME_PREFIX + stage.id,
                    status: 'infra',
                    value: null,
                    unit: 'ratio',
                    meta: { ...meta, reason: result ? 'the nightly result has no value' : 'no nightly result' },
                };
            }
            return {
                name: NAME_PREFIX + stage.id,
                status: VERDICT_STATUS[verdict] || 'infra',
                value: read.value,
                unit: 'ratio',
                meta: { ...meta, floor: read.floor, baseline: read.baseline, ...read.extra, verdict: verdict || null },
            };
        });
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
    const wiring = arg('wiring');
    const nightly = arg('nightly');
    if (!out || (!wiring && !nightly)) {
        console.error('usage: stage-signals.js (--wiring=<results.json> | --nightly=<result.json> --verdict=<v> [--stage=<id>]) --out=<rows.json>');
        return 2;
    }
    const rows = wiring ? wiringRows(readJson(wiring)) : nightlyRows(readJson(nightly), arg('verdict'), arg('stage') || 'finder');
    fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    for (const row of rows) console.log(`${row.status.padEnd(7)} ${row.name}${row.value === null ? '' : ` = ${row.value}`}`);
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { wiringRows, nightlyRows, READERS, NAME_PREFIX, catalogPath, usageMeta };
