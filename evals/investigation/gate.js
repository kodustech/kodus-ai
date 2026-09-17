// The finder-recall gate: a run's means against the floors calibrated for its
// case set, model and judge (evals/investigation/targets.json). Shared by
// run-recall.js and confirm-gate.js, which re-gates the mean of two runs.

function avg(values) {
    const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

/**
 * Absolute per-model floors (evals/investigation/targets.json). Gate is on the
 * RUN MEAN across the case set — never per-PR (per-PR recall noise is ±20pp;
 * single PRs scoring 0 is normal). Besides recallFloor, two low-noise collapse
 * detectors trip when the engine breaks rather than when recall wobbles:
 * minMeanFindings (prompt lost / findings not parsed) and minMeanToolCalls
 * (tools dead / loop not engaging).
 */
function evaluateGate(summary, rows, model, setName) {
    let targets;
    try {
        targets = loadTargets();
    } catch (err) {
        // Missing file → skip the gate. A malformed file must fail loudly
        // rather than silently disabling the gate.
        if (err.code === 'MODULE_NOT_FOUND') {
            return { status: 'skipped', reason: 'targets.json missing' };
        }
        throw err;
    }
    // Floors are per case set: a mean over 8 PRs and a mean over 30 are
    // different numbers. The top-level table is the `pr` set; others live
    // under `sets.<name>`.
    const set = setName === targets.set ? targets : targets.sets?.[setName];
    const target = set?.models?.[model];
    if (!target) {
        return { status: 'skipped', reason: `no target for model ${model} on set ${setName}` };
    }
    // A floor is only meaningful under the judge it was calibrated with: judges
    // disagree on borderline matches by several points of recall, enough to hide
    // a regression or invent one. Refuse to gate across judges.
    const { JUDGE_MODEL } = require('./recall-judge');
    if (set.judge && set.judge !== JUDGE_MODEL) {
        return { status: 'skipped', reason: `floors for set ${setName} were calibrated with judge ${set.judge}, this run used ${JUDGE_MODEL}` };
    }

    const meanFindings = avg(
        rows.map((row) => {
            const md = row.metadata || {};
            const tp = md.tpFindings;
            const fp = md.fpFindings;
            if (typeof tp !== 'number' || typeof fp !== 'number') return null;
            return tp + fp;
        }),
    );
    const meanToolCalls = avg(rows.map((row) => row.metadata?.totalCalls));

    const checks = [
        {
            name: 'recall_mean',
            actual: summary.metrics.recall_mean,
            floor: target.recallFloor,
        },
        { name: 'mean_findings', actual: meanFindings, floor: target.minMeanFindings },
        { name: 'mean_tool_calls', actual: meanToolCalls, floor: target.minMeanToolCalls },
    ].map((check) => ({
        ...check,
        pass:
            typeof check.actual === 'number' &&
            typeof check.floor === 'number' &&
            check.actual >= check.floor,
    }));

    return {
        status: checks.every((check) => check.pass) ? 'pass' : 'fail',
        checks,
        observed: target.observed || null,
    };
}


function loadTargets() {
    return require('./targets.json');
}

module.exports = { evaluateGate, avg };
