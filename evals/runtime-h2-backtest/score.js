// Scores the H2 backtest: did the Runtime's
// first Run on each replayed pull request publish the bug the maintainers later
// reverted or fixed, did two Kody reviews of the same pull request miss it, and
// did the controls stay clean. Pure: production's route matcher is passed in
// (run.js loads libs/runtime/entry-points/coverage.ts), so no rule is copied.

/** Findings a user reads as a regression: not a new endpoint, not a change the Run judged intended. */
function regressionFindings(run) {
    return (run?.outcome?.probes || []).filter(
        (p) => p.verdict === 'finding' && p.findingKind !== 'new_endpoint_error' && p.intent !== 'intended',
    );
}

/** The request a planned probe made: its method and path, for the route matcher. */
function requestOf(planProbe) {
    const spec = planProbe?.probe?.spec || {};
    let route = spec.path;
    if (!route && spec.url) {
        try {
            route = new URL(spec.url, 'http://app').pathname;
        } catch {
            route = undefined;
        }
    }
    return route ? { method: String(spec.method || 'GET').toUpperCase(), route } : null;
}

/** The first Run of a replayed pull request: what a user sees (§6.2). */
function firstRun(runs, kr, pr) {
    const mine = runs.filter((r) => String(r.repo).split('/').pop() === kr && Number(r.pr) === Number(pr));
    mine.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    return mine[0] || null;
}

const statusClass = (s) => (Number.isInteger(s) ? `${Math.floor(s / 100)}xx` : null);

/**
 * Whether one finding is the oracle's bug. Target: the finding's entry point, or the request its probe made, matches an
 * oracle target. Symptom, by its dimension: the status classes the oracle names on base and the PR; a field the oracle
 * names among those that differ; for dom and visual, both labelers' settled label (`symptom`).
 */
function matchesOracle(finding, planProbe, oracle, label, matches) {
    const req = requestOf(planProbe);
    const onTarget = (oracle.targets || []).some(
        (t) => t === finding.entryPoint || (req && matches(t, req)),
    );
    if (!onTarget) return { onTarget: false, agrees: false };
    const s = oracle.symptom || {};
    let agrees = false;
    if (s.dimension === 'status') {
        agrees = statusClass(finding.baseStatus) === s.good && statusClass(finding.prStatus) === s.buggy;
    } else if (s.dimension === 'field') {
        agrees = (finding.differingFields || []).some((f) => f === s.field || f.startsWith(`${s.field}.`));
    } else {
        agrees = settled(label?.symptom) === true;
    }
    // A finding on target with another symptom counts only when both labelers call it the same defect (§6.2).
    if (!agrees && settled(label?.adjacent) === true) agrees = true;
    return { onTarget: true, agrees };
}

/** A two-labeler label: {a, b, final}. Agreed: that value; disagreed: the written settlement, else undefined. */
function settled(l) {
    if (!l) return undefined;
    if (typeof l.final === 'boolean') return l.final;
    if (typeof l.a === 'boolean' && l.a === l.b) return l.a;
    return undefined;
}

/** Cohen's kappa on paired binary labels, with the raw agreement. */
function kappa(pairs) {
    const xs = pairs.filter((p) => typeof p.a === 'boolean' && typeof p.b === 'boolean');
    const n = xs.length;
    if (!n) return { n: 0, kappa: null, agreement: null };
    const agree = xs.filter((p) => p.a === p.b).length / n;
    const pa = xs.filter((p) => p.a).length / n;
    const pb = xs.filter((p) => p.b).length / n;
    const pe = pa * pb + (1 - pa) * (1 - pb);
    return { n, agreement: agree, kappa: pe === 1 ? 1 : (agree - pe) / (1 - pe) };
}

/** Wilson 95% interval of k successes in n. */
function wilson(k, n, z = 1.96) {
    if (!n) return [null, null];
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = p + (z * z) / (2 * n);
    const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return [(c - r) / d, (c + r) / d];
}

/**
 * One case or control against the export. A case is measured when its oracle reproduced (§6.1) and its first Run
 * exists; `found` when a regression finding matches the oracle; `reviewBlind` when two reviews were labeled and the
 * settled label of neither points at the bug.
 */
function scoreCase(c, runs, matches) {
    const out = { id: c.id, kind: c.kind, repo: c.kr, pr: c.krPr ?? null };
    if (c.kind === 'case' && c.reproduced !== true) return { ...out, measured: false, why: c.reproduced === false ? 'did_not_reproduce' : 'not_reproduced_yet' };
    if (c.notMeasured) return { ...out, measured: false, why: c.notMeasured };
    const run = c.krPr ? firstRun(runs, c.kr, c.krPr) : null;
    if (!run) return { ...out, measured: false, why: 'no_run' };
    const plan = new Map((run.plan?.probes || []).map((p) => [p.probe?.id, p]));
    const findings = regressionFindings(run);
    out.runId = run.runId;
    out.verdict = run.verdict;
    out.findings = findings.length;
    if (c.kind === 'control') {
        const labels = c.findingLabels || {};
        out.falseRegressions = findings.filter((f) => settled(labels[f.probeId]?.falseRegression) === true).length;
        out.unlabeled = findings.filter((f) => settled(labels[f.probeId]?.falseRegression) === undefined).length;
        return { ...out, measured: out.unlabeled === 0, ...(out.unlabeled ? { why: 'findings_unlabeled' } : {}) };
    }
    const labels = c.findingLabels || {};
    const judged = findings.map((f) => ({ probeId: f.probeId, ...matchesOracle(f, plan.get(f.probeId), c.oracle || {}, labels[f.probeId], matches) }));
    out.onTarget = judged.filter((j) => j.onTarget).length;
    out.found = judged.some((j) => j.agrees);
    const reviews = c.reviews || [];
    const points = reviews.map((r) => settled(r));
    out.reviews = reviews.length;
    out.reviewBlind = reviews.length >= 2 && points.every((p) => p === false) ? true : reviews.length >= 2 && points.some((p) => p === true) ? false : null;
    return { ...out, measured: true };
}

/**
 * The H2 result (§6.6): pass when at least 6 of the 20 reproduced cases are found, at least 2 of those are
 * review-blind, and at most 2 of the 10 controls carry a confirmed false regression. Fewer than 20 measured cases is
 * reported as insufficient, never padded; a broken control guard is not interpretable whatever the recall.
 */
function scoreAll(cases, traces, { matches, minCases = 20, minFound = 6, minBlind = 2, maxFalseControls = 2 } = {}) {
    if (typeof matches !== 'function') throw new Error('scoreAll needs the production route matcher');
    const runs = traces?.runs || [];
    const scored = cases.map((c) => scoreCase(c, runs, matches));
    const casesIn = scored.filter((s) => s.kind === 'case' && s.measured);
    const controlsIn = scored.filter((s) => s.kind === 'control' && s.measured);
    const found = casesIn.filter((s) => s.found);
    const blindFound = found.filter((s) => s.reviewBlind === true);
    const blindUnknown = found.filter((s) => s.reviewBlind === null).length;
    const falseControls = controlsIn.filter((s) => s.falseRegressions > 0).length;
    const funnel = {
        pairs: cases.filter((c) => c.kind === 'case').length,
        reproduced: cases.filter((c) => c.kind === 'case' && c.reproduced === true).length,
        measured: casesIn.length,
        found: found.length,
        reviewBlindFound: blindFound.length,
        controls: cases.filter((c) => c.kind === 'control').length,
        controlsMeasured: controlsIn.length,
        controlsWithFalseRegression: falseControls,
    };
    let verdict;
    if (falseControls > maxFalseControls) verdict = 'not_interpretable';
    else if (casesIn.length < minCases) verdict = 'insufficient';
    else if (blindUnknown && found.length >= minFound && blindFound.length < minBlind) verdict = 'insufficient';
    else verdict = found.length >= minFound && blindFound.length >= minBlind ? 'pass' : 'fail';
    const reviewPairs = cases.flatMap((c) => c.reviews || []);
    const findingPairs = cases.flatMap((c) => Object.values(c.findingLabels || {}).flatMap((l) => [l.adjacent, l.symptom, l.falseRegression].filter(Boolean)));
    return {
        verdict,
        funnel,
        recall: { found: found.length, of: casesIn.length, wilson95: wilson(found.length, casesIn.length) },
        agreement: { review: kappa(reviewPairs), findings: kappa(findingPairs) },
        cases: scored,
    };
}

module.exports = { scoreAll, scoreCase, matchesOracle, regressionFindings, firstRun, settled, kappa, wilson, requestOf };
