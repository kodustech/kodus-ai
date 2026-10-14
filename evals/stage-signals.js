// One quality signal per review stage (#2114): `evals.stage.<id>` in BigQuery
// `quality.signals`, for every stage in evals/stages.js, so the quality panel
// lists each stage with its eval, or `none`.
//
//   node evals/stage-signals.js --wiring=<results.json> --out=<rows.json>
//       results from `evals/wiring-smoke.js --results`. Every stage except the
//       nightly-measured ones: green or red from its wiring steps, infra when a
//       step did not run, skipped for a stage with no scheduled eval.
//   node evals/stage-signals.js --nightly=<nightly.json> --verdict=<verdict> --out=<rows.json>
//       the nightly-measured stages: recall against the floor, status from the
//       nightly verdict (evals/ci-report.js).
//
// Writes a JSON array of rows for .github/actions/report-signal (`rows`). Telemetry:
// it never fails a job over a result, only over bad arguments (exit 2).
const fs = require('fs');
const { STAGES } = require('./stages');

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

function baseMeta(stage) {
    // order: position in the review, so the panel lists stages as they run.
    const index = STAGES.findIndex((s) => s.id === stage.id);
    return { stage: stage.label, order: index >= 0 ? index + 1 : null, eval: stage.eval, measured: stage.model, wiring: stage.wiring, note: stage.note };
}

function wiringRows(results, stages = STAGES) {
    const byStep = new Map((results || []).map((r) => [r.step, r]));
    return stages
        .filter((stage) => !stage.nightly)
        .map((stage) => {
            const meta = baseMeta(stage);
            if (!stage.wiring.length) {
                return { name: NAME_PREFIX + stage.id, status: 'skipped', value: null, unit: null, meta };
            }
            const missing = stage.wiring.filter((step) => !byStep.has(step));
            if (missing.length) {
                return {
                    name: NAME_PREFIX + stage.id,
                    status: 'infra',
                    value: null,
                    unit: null,
                    meta: { ...meta, reason: `wiring step(s) did not run: ${missing.join(', ')}` },
                };
            }
            const failed = stage.wiring.map((step) => byStep.get(step)).filter((r) => !r.ok);
            return {
                name: NAME_PREFIX + stage.id,
                status: failed.length ? 'red' : 'green',
                value: null,
                unit: null,
                meta: failed.length
                    ? { ...meta, reason: failed.map((r) => `${r.step}: ${r.problem}`).join('; '), failed: failed.map((r) => r.step) }
                    : meta,
            };
        });
}

function nightlyRows(nightly, verdict, stages = STAGES) {
    return stages
        .filter((stage) => stage.nightly)
        .map((stage) => {
            const meta = baseMeta(stage);
            const recall = nightly?.metrics?.recall_mean;
            if (!nightly || !Number.isFinite(recall)) {
                return {
                    name: NAME_PREFIX + stage.id,
                    status: 'infra',
                    value: null,
                    unit: 'ratio',
                    meta: { ...meta, reason: nightly ? 'the nightly result has no recall' : 'no nightly result' },
                };
            }
            const check = (nightly.gate?.checks || []).find((c) => c.name === 'recall_mean');
            return {
                name: NAME_PREFIX + stage.id,
                status: VERDICT_STATUS[verdict] || 'infra',
                value: recall,
                unit: 'ratio',
                meta: {
                    ...meta,
                    floor: check?.floor ?? null,
                    baseline: nightly.gate?.observed?.recall_mean ?? null,
                    precision: nightly.metrics.precision_mean ?? null,
                    model: nightly.model || null,
                    cases: nightly.cases ?? null,
                    unmeasured: nightly.unmeasured ?? null,
                    verdict: verdict || null,
                },
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
        console.error('usage: stage-signals.js (--wiring=<results.json> | --nightly=<nightly.json> --verdict=<v>) --out=<rows.json>');
        return 2;
    }
    const rows = wiring ? wiringRows(readJson(wiring)) : nightlyRows(readJson(nightly), arg('verdict'));
    fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
    for (const row of rows) console.log(`${row.status.padEnd(7)} ${row.name}${row.value === null ? '' : ` = ${row.value}`}`);
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { wiringRows, nightlyRows, NAME_PREFIX };
