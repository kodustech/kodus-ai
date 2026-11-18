// Rule 7: each check of score.js turns red on a deliberate break. Run: node --test evals/runtime-h2-backtest/score.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { registerTs } = require('../shared/eval-kit');
const { scoreAll, scoreCase, kappa, wilson } = require('./score');

registerTs();
const { requestMatchesEntryPoint: matches } = require(path.join(__dirname, '..', '..', 'libs/runtime/entry-points/coverage.ts'));

const oracle = { targets: ['POST /api/bookings/:id/cancel'], symptom: { dimension: 'status', good: '2xx', buggy: '5xx' } };
const run = (pr, probes, at = '2026-11-20T10:00:00Z') => ({
    runId: `run-${pr}-${at}`,
    repo: 'example-org/demo-calcom',
    pr,
    requestedAt: at,
    verdict: 'regression',
    plan: { probes: probes.map((p) => ({ probe: { id: p.probeId, spec: { kind: 'http', method: p.method || 'POST', path: p.path } } })) },
    outcome: { probes: probes.map(({ method, path: _p, ...o }) => ({ verdict: 'finding', findingKind: 'behavior_change', ...o })) },
});
const theBug = { probeId: 'p1', path: '/api/bookings/42/cancel', entryPoint: 'unmapped', baseStatus: 200, prStatus: 500 };
const blind = [{ a: false, b: false }, { a: false, b: false }];
const kase = (id, krPr, extra = {}) => ({ id, kind: 'case', kr: 'demo-calcom', krPr, reproduced: true, oracle, reviews: blind, ...extra });

test('a regression on the oracle route with the oracle status classes is found, through the production matcher', () => {
    const s = scoreCase(kase('c1', 1), [run(1, [theBug])], matches);
    assert.strictEqual(s.found, true);
    assert.strictEqual(s.reviewBlind, true);
});

test('the same difference on another route, the reverse status, an intended or a new-endpoint finding is not found', () => {
    for (const p of [
        { ...theBug, path: '/api/bookings/42' },
        { ...theBug, baseStatus: 500, prStatus: 200 },
        { ...theBug, prStatus: 200, differingFields: ['json.title'] },
        { ...theBug, intent: 'intended' },
        { ...theBug, findingKind: 'new_endpoint_error' },
    ])
        assert.strictEqual(scoreCase(kase('c', 1), [run(1, [p])], matches).found, false, JSON.stringify(p));
    const inconclusive = run(1, [theBug]);
    inconclusive.outcome.probes[0].verdict = 'inconclusive';
    assert.strictEqual(scoreCase(kase('c', 1), [inconclusive], matches).found, false);
});

test('only the first Run of the pull request counts', () => {
    const later = run(1, [theBug], '2026-11-21T10:00:00Z');
    const first = run(1, [], '2026-11-20T10:00:00Z');
    assert.strictEqual(scoreCase(kase('c', 1), [later, first], matches).found, false);
});

test('a field symptom needs that field among the differing ones; dom needs both labelers', () => {
    const fieldCase = kase('f', 2, { oracle: { targets: oracle.targets, symptom: { dimension: 'field', field: 'json.status' } } });
    assert.strictEqual(scoreCase(fieldCase, [run(2, [{ ...theBug, differingFields: ['json.status'] }])], matches).found, true);
    assert.strictEqual(scoreCase(fieldCase, [run(2, [{ ...theBug, differingFields: ['json.title'] }])], matches).found, false);
    const domCase = kase('d', 3, { oracle: { targets: ['GET /bookings'], symptom: { dimension: 'dom' } } });
    const dom = run(3, [{ probeId: 'p1', method: 'GET', path: '/bookings', entryPoint: 'GET /bookings' }]);
    assert.strictEqual(scoreCase(domCase, [dom], matches).found, false);
    assert.strictEqual(scoreCase({ ...domCase, findingLabels: { p1: { symptom: { a: true, b: false } } } }, [dom], matches).found, false);
    assert.strictEqual(scoreCase({ ...domCase, findingLabels: { p1: { symptom: { a: true, b: false, final: true } } } }, [dom], matches).found, true);
});

test('review-blind needs two labeled reviews, neither pointing at the bug', () => {
    assert.strictEqual(scoreCase(kase('c', 1, { reviews: [{ a: false, b: false }] }), [run(1, [theBug])], matches).reviewBlind, null);
    assert.strictEqual(scoreCase(kase('c', 1, { reviews: [{ a: false, b: false }, { a: true, b: true }] }), [run(1, [theBug])], matches).reviewBlind, false);
});

test('a case that did not reproduce, or has no Run, is not measured and never counts as a miss', () => {
    assert.strictEqual(scoreCase({ ...kase('c', 1), reproduced: false }, [run(1, [theBug])], matches).measured, false);
    assert.strictEqual(scoreCase(kase('c', 9), [run(1, [theBug])], matches).measured, false);
});

test('pass at 6 of 20 with 2 review-blind; fail at 5; insufficient below 20 cases; controls guard', () => {
    const cases = [];
    const runs = [];
    for (let i = 1; i <= 20; i++) {
        cases.push(kase(`c${i}`, i, { reviews: i <= 2 ? blind : [{ a: true, b: true }, { a: true, b: true }] }));
        runs.push(run(i, i <= 6 ? [theBug] : []));
    }
    assert.strictEqual(scoreAll(cases, { runs }, { matches }).verdict, 'pass');
    const five = runs.map((r, i) => (i === 5 ? run(6, []) : r));
    assert.strictEqual(scoreAll(cases, { runs: five }, { matches }).verdict, 'fail');
    assert.strictEqual(scoreAll(cases.slice(0, 19), { runs }, { matches }).verdict, 'insufficient');
    const controls = [1, 2, 3].map((i) => ({ id: `k${i}`, kind: 'control', kr: 'demo-calcom', krPr: 100 + i, findingLabels: { p1: { falseRegression: { a: true, b: true } } } }));
    const controlRuns = controls.map((c) => run(c.krPr, [theBug]));
    assert.strictEqual(scoreAll([...cases, ...controls], { runs: [...runs, ...controlRuns] }, { matches }).verdict, 'not_interpretable');
    assert.strictEqual(scoreAll([...cases, ...controls.slice(0, 2)], { runs: [...runs, ...controlRuns] }, { matches }).verdict, 'pass');
});

test('the scorer refuses to run without the production matcher', () => {
    assert.throws(() => scoreAll([], { runs: [] }), /production route matcher/);
});

test('Wilson interval and kappa', () => {
    const [lo, hi] = wilson(6, 20);
    assert.ok(Math.abs(lo - 0.145) < 0.005 && Math.abs(hi - 0.519) < 0.005, `${lo} ${hi}`);
    assert.strictEqual(kappa([{ a: true, b: true }, { a: false, b: false }]).kappa, 1);
    assert.ok(kappa([{ a: true, b: false }, { a: false, b: true }]).kappa < 0);
});
