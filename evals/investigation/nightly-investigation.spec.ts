/**
 * The nightly's comparison and the agent contract. The comparison names the
 * known bugs lost between nights; the extractor must refuse anything but a
 * well-formed verdict, so a garbled agent answer never reaches Discord as if it
 * were a finding.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compareNights, nightNoise, costUpperBound, catalogIdFor } = require('./nightly-compare');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractInvestigation } = require('./extract-investigation');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildFacts } = require('./investigate-facts');

const row = (caseId: string, recall: number, found: string[], missed: string[] = []) => ({
    caseId,
    status: 'pass',
    metadata: {
        recall,
        precision: 0.5,
        tpFindings: 1,
        fpFindings: 0,
        totalCalls: 20,
        hitRate: 0.8,
        goldenResults: [...found.map((golden) => ({ golden, found: true })), ...missed.map((golden) => ({ golden, found: false }))],
    },
});

describe('nightly comparison', () => {
    const lastGreen = { rows: [row('a', 1, ['x', 'y']), row('b', 0.5, ['z'], ['w'])] };
    const tonight = { rows: [row('a', 0.5, ['x'], ['y']), row('b', 1, ['z', 'w']), { caseId: 'c', status: 'infra', reason: 'quota' }] };

    it('lists the known bugs lost and gained per PR, worst drop first, ignoring unmeasured PRs', () => {
        const c = compareNights(tonight, lastGreen);
        expect(c.perCase.map((p: { caseId: string }) => p.caseId)).toEqual(['a', 'b']);
        expect(c.perCase[0]).toMatchObject({ caseId: 'a', delta: -0.5, lost: ['y'], gained: [] });
        expect(c.perCase[1]).toMatchObject({ caseId: 'b', lost: [], gained: ['w'] });
        expect(c).toMatchObject({ recall: 0.75, recallBefore: 0.75, recallDelta: 0, lostTotal: 1, gainedTotal: 1 });
    });

    it("doesn't claim bug-level changes when the older night has no per-bug results", () => {
        const old = { rows: [{ caseId: 'a', status: 'pass', metadata: { recall: 1, precision: 1 } }] };
        const c = compareNights({ rows: [row('a', 0.5, ['x'])] }, old);
        expect(c.perCase[0].lost).toBeNull();
        expect(c.lostTotal).toBeNull();
    });

    it('derives the night noise from the calibration, and prices only catalog models', () => {
        const targets = { sets: { light: { models: { m: { observed: { sdPerPrRunDiff: 0.318, runs: [0.384, 0.352] } } } } } };
        expect(nightNoise(targets, 'light', 'm')).toBeCloseTo(0.05, 2);
        expect(nightNoise(targets, 'light', 'other')).toBeNull();
        expect(catalogIdFor('deepseek-v4-flash@fireworks')).toBe('fireworks/accounts/fireworks/models/deepseek-v4-flash-0731');
        expect(catalogIdFor('gpt-5.4')).toBeNull();
        expect(costUpperBound({ prompt: 1e6, completion: 0 }, 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731')).toBeGreaterThan(0);
        expect(costUpperBound({ prompt: 1e6, completion: 0 }, 'not-in-catalog')).toBeNull();
    });
});

describe('investigation facts', () => {
    it('gives the agent the lost bugs next to both nights\' findings and the commits measured', () => {
        const facts = buildFacts({
            tonight: { model: 'm', cases: 1, rows: [row('a', 0, [], ['token leak'])], gate: { status: 'fail', checks: [] } },
            tonightSubmission: { results: [{ caseId: 'a', findings: [{ path: 'x.ts', startLine: 3, severity: 'low', description: 'style nit' }] }] },
            lastGreen: { rows: [row('a', 1, ['token leak'])] },
            lastGreenSubmission: { results: [{ caseId: 'a', findings: [{ path: 'auth.ts', startLine: 9, severity: 'high', description: 'token leaks into logs' }] }] },
            commits: [{ sha: 'abc1234', subject: 'refactor(llm): x', author: 'dev' }],
            engineChanges: ['libs/llm/x.ts'],
            targets: {},
        });
        expect(facts).toContain('- abc1234 refactor(llm): x (dev)');
        expect(facts).toContain('Known bugs found last green night, missed tonight:\n  - token leak');
        expect(facts).toContain('auth.ts:9 [high] token leaks into logs');
        expect(facts).toContain('x.ts:3 [low] style nit');
    });
});

describe('investigation contract', () => {
    const answer = (json: string) => `## Report\nThe drop is noise.\n\n\`\`\`json\n${json}\n\`\`\``;

    it('takes the last json block and the report before it', () => {
        const raw = `${answer('{"verdict":"unclear","confidence":"low","summary":"x"}')}\n\n${answer('{"verdict":"regression","confidence":"medium","summary":"The drop came from abc.","suspects":[{"commit":"abc","file":"libs/a.ts:3","why":"it changed"},{"why":"no target"}],"confirm":"run it"}')}`;
        const { investigation, report } = extractInvestigation(raw);
        expect(investigation).toEqual({ verdict: 'regression', confidence: 'medium', summary: 'The drop came from abc.', suspects: [{ commit: 'abc', file: 'libs/a.ts:3', why: 'it changed' }], confirm: 'run it' });
        expect(report).toContain('The drop is noise.');
    });

    it.each([
        ['no block', 'just prose'],
        ['bad json', answer('{"verdict":')],
        ['unknown verdict', answer('{"verdict":"guilty","confidence":"high","summary":"x"}')],
        ['unknown confidence', answer('{"verdict":"noise","confidence":"certain","summary":"x"}')],
        ['empty summary', answer('{"verdict":"noise","confidence":"high","summary":" "}')],
    ])('refuses %s', (_label, raw) => {
        expect(extractInvestigation(raw).error).toBeTruthy();
    });
});

describe('comparing two nights that measured different PRs', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { compareNights } = require('./nightly-compare');
    const row = (caseId: string, recall: number) => ({ caseId, status: 'pass', metadata: { recall, precision: 0.5, goldenResults: [{ golden: 'bug', found: recall > 0 }] } });

    it('skips a PR whose metric is missing on one side, on both sides', () => {
        const green = { rows: [row('a', 0.4), row('b', 1)] };
        // 'b' parsed on the green night and not tonight: keeping the green 100%
        // while tonight's average has only 'a' reads as a 60pp collapse.
        const tonight = { rows: [row('a', 0.4), { caseId: 'b', status: 'fail', metadata: {} }] };
        const comparison = compareNights(tonight, green);
        expect(comparison.recall).toBeCloseTo(0.4);
        expect(comparison.recallBefore).toBeCloseTo(0.4);
        expect(comparison.recallDelta).toBeCloseTo(0);
    });

    it('averages the PRs both nights measured, not two different subsets', () => {
        const green = { rows: [row('a', 0.4), row('b', 0.4), row('c', 1)] };
        // Tonight lost 'c' to infra: counting the green night's 'c' would read
        // as a 20pp drop that never happened.
        const tonight = { rows: [row('a', 0.4), row('b', 0.4), { caseId: 'c', status: 'infra', reason: 'provider 429' }] };
        const comparison = compareNights(tonight, green);
        expect(comparison.casesCompared).toBe(2);
        expect(comparison.recall).toBeCloseTo(0.4);
        expect(comparison.recallBefore).toBeCloseTo(0.4);
        expect(comparison.recallDelta).toBeCloseTo(0);
    });
});

describe('confirmation of a run below the floor', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { combineRuns } = require('./confirm-gate');
    const run = (recall: number, found: boolean) => ({
        model: 'm',
        metrics: { recall_mean: recall, precision_mean: 0.5, f1_mean: recall / 2 },
        tokens: { prompt: 10, completion: 1 },
        rows: [{ caseId: 'a', status: 'pass', metadata: { recall, precision: 0.5, tpFindings: 1, fpFindings: 0, totalCalls: 20, goldenResults: [{ golden: 'bug', found }] } }],
    });

    it('decides on the mean of both runs and counts a bug found by either as found', () => {
        const gateFor = (summary: { metrics: { recall_mean: number } }) => ({ status: summary.metrics.recall_mean >= 0.3 ? 'pass' : 'fail', checks: [] });
        const combined = combineRuns(run(0.2, false), run(0.5, true), gateFor);
        expect(combined.metrics.recall_mean).toBeCloseTo(0.35);
        expect(combined.gate).toMatchObject({ status: 'pass', confirmation: { runs: [0.2, 0.5] } });
        expect(combined.rows[0].metadata.goldenResults).toEqual([{ golden: 'bug', found: true }]);
        expect(combined.tokens).toEqual({ prompt: 20, completion: 2 });
    });

    it('confirms when the second run missed only the PRs its budget allows', () => {
        const second = { ...run(0.5, true), infraFailures: 1, infraBudget: 2 };
        const combined = combineRuns(run(0.2, false), second, () => ({ status: 'fail', checks: [] }));
        expect(combined.confirmationError).toBeUndefined();
        expect(combined.gate.confirmation.secondInfra).toBe(1);
    });

    it('decides on the PRs both runs measured, not on one run of 2 and one of 1', () => {
        const two = (recalls: number[]) => ({
            model: 'm',
            metrics: { recall_mean: recalls.reduce((a, b) => a + b, 0) / recalls.length },
            rows: recalls.map((recall, i) => ({ caseId: `c${i}`, status: 'pass', metadata: { recall, precision: 0.5, goldenResults: [{ golden: `g${i}`, found: recall > 0 }] } })),
        });
        const first = two([0.2, 1]);
        // The second run skipped the PR that scores 1: averaging the two run
        // means would read 0.4 and pass a floor the paired PRs do not clear.
        const second = { ...two([0.2]), rows: [two([0.2]).rows[0], { caseId: 'c1', status: 'infra', reason: '429' }], infraFailures: 1, infraBudget: 1 };
        const combined = combineRuns(first, second, () => ({ status: 'fail', checks: [] }));
        expect(combined.metrics.recall_mean).toBeCloseTo(0.2);
        expect(combined.gate.confirmation.pairedCases).toBe(1);
    });

    it('keeps every metric and count run-recall writes', () => {
        const combined = combineRuns(run(0.2, false), run(0.6, true), () => ({ status: 'pass', checks: [] }));
        expect(combined.metrics.f1_mean).toBeCloseTo(0.2);
        expect(combined).toMatchObject({ model: 'm', cases: 1, passed: 1, failed: 0 });
    });
});

describe('gate refuses a judge it was not calibrated with', () => {
    const run = { metrics: { recall_mean: 0.4 }, rows: [{ caseId: 'a', status: 'pass', metadata: { recall: 0.4, tpFindings: 2, fpFindings: 1, totalCalls: 40 } }] };
    const gateUnder = (env: Record<string, string | undefined>) => {
        const saved = { JUDGE_MODEL: process.env.JUDGE_MODEL, JUDGE_REASONING_EFFORT: process.env.JUDGE_REASONING_EFFORT };
        Object.assign(process.env, env);
        for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
        let result: { status: string; reason?: string } = { status: '' };
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { evaluateGate } = require('./gate');
            result = evaluateGate(run, run.rows, 'deepseek-v4-flash@fireworks', 'light');
        });
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        return result;
    };

    it('gates under the calibrated judge and effort', () => {
        expect(gateUnder({ JUDGE_MODEL: 'gpt-5.6-luna', JUDGE_REASONING_EFFORT: 'low' }).status).toBe('pass');
    });

    it.each([
        [{ JUDGE_MODEL: 'gpt-5.4-mini', JUDGE_REASONING_EFFORT: 'low' }],
        [{ JUDGE_MODEL: 'gpt-5.6-luna', JUDGE_REASONING_EFFORT: undefined }],
        [{ JUDGE_MODEL: 'gpt-5.6-luna', JUDGE_REASONING_EFFORT: 'high' }],
    ])('skips when the judge or its effort differ: %j', (env) => {
        const result = gateUnder(env);
        expect(result.status).toBe('skipped');
        expect(result.reason).toContain('gpt-5.6-luna (effort low)');
    });
});
