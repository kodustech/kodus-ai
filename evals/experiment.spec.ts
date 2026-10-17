// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compare, comparisonOf, decide, phaseVerdict, affectedSteps } = require('./experiment');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pairsOf, scoreCase } = require('./dedup-groups/run');

type Case = { id: string; checks: string; hits: number; total: number; unmeasured?: boolean };
const run = (cases: Case[]) => ({ cases });
const c = (id: string, hits: number, total: number): Case => ({ id, checks: `checks ${id}`, hits, total });

describe('evals/experiment.js compare', () => {
    it('calls two identical sides a tie with no difference', () => {
        const side = [run([c('a', 3, 4), c('b', 2, 2), c('c', 1, 3)]), run([c('a', 3, 4), c('b', 2, 2), c('c', 1, 3)])];
        const r = compare(side, side);
        expect(r).toMatchObject({ cases: 3, diff: 0, verdict: 'tie', worse: [], better: [] });
    });

    it('calls a candidate better only when the interval over the cases clears zero', () => {
        const ids = Array.from({ length: 20 }, (_, i) => `pr${i}`);
        const base = [run(ids.map((id) => c(id, 2, 4))), run(ids.map((id) => c(id, 2, 4)))];
        const cand = [run(ids.map((id) => c(id, 4, 4))), run(ids.map((id) => c(id, 4, 4)))];
        const r = compare(base, cand);
        expect(r.verdict).toBe('better');
        expect(r.diff).toBeCloseTo(0.5);
        expect(r.ci[0]).toBeGreaterThan(0);
        expect(r.better).toHaveLength(20);
    });

    it('pairs only the cases both sides measured in every run', () => {
        const base = [run([c('a', 1, 2), c('b', 2, 2)]), run([c('a', 1, 2), { ...c('b', 0, 0), unmeasured: true }])];
        const cand = [run([c('a', 2, 2), c('b', 0, 2)]), run([c('a', 2, 2), c('b', 0, 2)])];
        const r = compare(base, cand);
        expect(r.cases).toBe(1);
        expect(r.base).toBeCloseTo(0.5);
        expect(r.candidate).toBe(1);
    });

    it('lists a case that got worse, and a guard with one is a regression', () => {
        const base = [run([c('a', 2, 2), c('b', 1, 1)])];
        const cand = [run([c('a', 1, 2), c('b', 1, 1)])];
        const guard = { id: 'g', role: 'guard', comparison: compare(base, cand) };
        expect(guard.comparison.worse.map((x: { id: string }) => x.id)).toEqual(['a']);
        const primaryTie = { id: 'p', role: 'primary', comparison: { verdict: 'tie', worse: [] } };
        expect(phaseVerdict('regression', [primaryTie, guard])).toBe('regression');
        expect(phaseVerdict('regression', [primaryTie, { ...guard, comparison: { verdict: 'tie', worse: [] } }])).toBe('no regression');
        expect(phaseVerdict('decision', [{ ...primaryTie, comparison: { verdict: 'better', worse: [] } }])).toBe('better');
    });
});

describe('evals/experiment.js decide', () => {
    const changed = { base: { step: 'x' }, candidate: { step: 'y' } };
    const usage = (n: number) => ({ usage: { in: n, out: 0 } });
    const primary = (verdict: string, base = 10, cand = 10) => ({ id: 'p', role: 'primary', comparison: { verdict, worse: [] }, sides: { base: usage(base), candidate: usage(cand) } });
    const phase = (verdict: string, evals: unknown[]) => ({ verdict, evals });

    it('ships only when nothing regressed and the decision phase is better, or ties for fewer tokens', () => {
        expect(decide({ regression: phase('no regression', [primary('tie')]), decision: phase('better', [primary('better')]) }, changed).decision).toBe('ships');
        expect(decide({ regression: phase('no regression', [primary('tie')]), decision: phase('tie', [primary('tie', 10, 5)]) }, changed).decision).toBe('ships');
        expect(decide({ regression: phase('no regression', [primary('tie')]), decision: phase('tie', [primary('tie', 10, 20)]) }, changed).decision).toBe('does not ship');
        expect(decide({ regression: phase('regression', [primary('worse')]), decision: phase('better', [primary('better')]) }, changed).decision).toBe('does not ship');
    });

    it('says no regression, not ships, when only the regression phase ran', () => {
        expect(decide({ regression: phase('no regression', [primary('better')]) }, changed)).toMatchObject({ decision: 'no regression' });
    });

    it('says nothing changed when the step version is the same on both sides', () => {
        expect(decide({ regression: phase('no regression', [primary('tie')]) }, { base: { step: 'x' }, candidate: { step: 'x' } }).decision).toBe('no change in this step');
    });
});

describe('evals/dedup-groups scoring', () => {
    const testCase = {
        id: 'pool/pr',
        groups: [['S1', 'S2', 'S3'], ['S4'], ['S5']],
        suggestions: ['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => ({ id, suggestionContent: `text of ${id}` })),
    };

    it('counts every pair inside a group once', () => {
        expect([...pairsOf([['S2', 'S1', 'S3'], ['S4']])]).toEqual(['S1|S2', 'S1|S3', 'S2|S3']);
    });

    it('scores the gold pairs joined and the merges the gold keeps apart', () => {
        // The dedup kept S1 with S2 merged into it, and merged S5 into S4.
        const r = scoreCase(testCase, { groups: [[0, 1], [3, 4]], kept: [0, 2, 3], status: 'success' });
        expect(r).toMatchObject({ hits: 1, total: 3, falseMerges: 1, falseMergePairs: ['S4|S5'], kept: 3, goldGroups: 3 });
    });
});

describe('evals/experiment.js affectedSteps', () => {
    const steps = { dedup: { smoke: ['funnel-dedup'] }, verify: { smoke: ['funnel-verify'] } };
    const files: Record<string, string[]> = {
        'funnel-dedup': ['libs/code-review/pipeline/stages/agent-review.stage.ts', 'evals/funnel/dedup/run.js'],
        'funnel-verify': ['libs/code-review/infrastructure/agents/core/verifier.agent.ts'],
    };
    const filesOf = (name: string) => files[name] || [];

    it('runs the experiment of a step whose production files the change touched', () => {
        expect(affectedSteps(['libs/code-review/pipeline/stages/agent-review.stage.ts', 'README.md'], filesOf, steps)).toEqual(['dedup']);
    });

    it('ignores a change to the eval or to files no step loads', () => {
        expect(affectedSteps(['evals/funnel/dedup/run.js', 'apps/web/page.tsx'], filesOf, steps)).toEqual([]);
    });
});

describe('evals/experiment.js main refuses what it cannot compare', () => {
    const run = async (argv: string[]) => {
        const saved = process.argv;
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            process.argv = ['node', 'experiment.js', ...argv];
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const code = await require('./experiment').main();
            return { code, said: error.mock.calls.map((c) => String(c[0])).join('\n') };
        } finally {
            process.argv = saved;
            error.mockRestore();
        }
    };

    it('a model outside tier0-models.js', async () => {
        expect(await run(['--step=dedup', '--model=gpt-unknown'])).toMatchObject({ code: 2, said: expect.stringContaining('tier0-models.js') });
    });

    it('an affected-steps query whose inputs are missing: unknown, not "nothing changed"', async () => {
        expect(await run(['--affected', '--files-dir=/nonexistent', '--changed=/nonexistent/changed.txt'])).toMatchObject({ code: 2, said: expect.stringContaining('cannot tell which steps changed') });
    });

    it('the decision phase without the regression phase', async () => {
        expect(await run(['--step=dedup', '--phases=decision'])).toMatchObject({ code: 2, said: expect.stringContaining('needs regression') });
    });
});

describe('evals/experiment.js comparisonOf', () => {
    it('is not measured when a requested run is missing on either side', () => {
        const ok = { cases: [{ id: 'a', checks: 'a', hits: 1, total: 2 }] };
        const better = { cases: [{ id: 'a', checks: 'a', hits: 2, total: 2 }] };
        expect(comparisonOf([ok, ok], [better, better]).verdict).not.toBe('not measured');
        expect(comparisonOf([ok, ok], [better, null])).toMatchObject({ verdict: 'not measured', missingRuns: { base: 0, candidate: 1 } });
    });
});

describe('evals/experiment.js derived measures', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deriveRuns, STEP_EVALS } = require('./experiment');
    const precision = STEP_EVALS.dedup.primary.derived[0];

    it("reads the dedup's merges that were right from its cases", () => {
        const [run] = deriveRuns([{ cases: [{ id: 'a', checks: 'x', hits: 3, total: 4, merged: 5, falseMerges: 1 }, { id: 'b', unmeasured: true, hits: 0, total: 0 }] }], precision);
        expect(run.cases).toEqual([{ id: 'a', checks: precision.question, hits: 4, total: 5 }]);
    });

    it('a derived measure fails a phase only beyond its interval, not on one case', () => {
        const primary = { id: 'p', role: 'primary', comparison: { verdict: 'better', worse: [] } };
        const oneCaseWorse = { id: 'pair-precision', role: 'guard', rule: 'interval', comparison: { verdict: 'tie', worse: [{ id: 'a' }] } };
        expect(phaseVerdict('regression', [primary, oneCaseWorse])).toBe('no regression');
        expect(phaseVerdict('regression', [primary, { ...oneCaseWorse, comparison: { verdict: 'worse', worse: [] } }])).toBe('regression');
        const changed = { base: { step: 'x' }, candidate: { step: 'y' } };
        const sides = { base: { usage: { in: 1 } }, candidate: { usage: { in: 1 } } };
        const decision = { verdict: 'better', evals: [{ ...primary, sides }, { ...oneCaseWorse, comparison: { verdict: 'worse', worse: [] } }] };
        expect(decide({ regression: { verdict: 'no regression', evals: [primary] }, decision }, changed).decision).toBe('does not ship');
    });
});

describe('evals/experiment.js measuredAlready', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { measuredAlready } = require('./experiment');
    const recorded = [{ experiment: 'x', phases: ['regression', 'decision'], step_blobs: { base: { 'libs/a.ts': 'a1', 'libs/b.ts': 'b1' }, candidate: { 'libs/a.ts': 'a2', 'libs/b.ts': 'b1' } } }];
    const blobsOf = (now: Record<string, Record<string, string>>) => (side: string, files: string[]) => Object.fromEntries(files.map((f) => [f, now[side][f]]));

    it('finds the experiment that measured exactly this code', () => {
        const now = { base: { 'libs/a.ts': 'a1', 'libs/b.ts': 'b1' }, candidate: { 'libs/a.ts': 'a2', 'libs/b.ts': 'b1' } };
        expect(measuredAlready(recorded, ['regression'], blobsOf(now))).toBe(recorded[0]);
    });

    it('runs again when a step file differs on either side, or a phase was not measured', () => {
        const branchChanged = { base: { 'libs/a.ts': 'a1', 'libs/b.ts': 'b1' }, candidate: { 'libs/a.ts': 'a3', 'libs/b.ts': 'b1' } };
        const mainChanged = { base: { 'libs/a.ts': 'a1', 'libs/b.ts': 'b9' }, candidate: { 'libs/a.ts': 'a2', 'libs/b.ts': 'b1' } };
        expect(measuredAlready(recorded, ['regression'], blobsOf(branchChanged))).toBeNull();
        expect(measuredAlready(recorded, ['regression'], blobsOf(mainChanged))).toBeNull();
        expect(measuredAlready([{ ...recorded[0], phases: ['regression'] }], ['regression', 'decision'], blobsOf({ base: recorded[0].step_blobs.base, candidate: recorded[0].step_blobs.candidate }))).toBeNull();
    });
});

describe('evals/shared/quality-client.js', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const client = require('./shared/quality-client');
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
        jest.restoreAllMocks();
    });

    it('does not send without a token, and says why', async () => {
        delete process.env.KODUS_QUALITY_INGEST_TOKEN;
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toMatchObject({ sent: false, reason: expect.stringContaining('KODUS_QUALITY_INGEST_TOKEN') });
    });

    it('posts the rows with the token, and reports a refusal without throwing', async () => {
        process.env.KODUS_QUALITY_INGEST_TOKEN = 't';
        process.env.KODUS_QUALITY_URL = 'https://panel.test/';
        const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ inserted: 1, url: 'https://panel.test/experiments' }), { status: 200 }));
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toEqual({ sent: true, url: 'https://panel.test/experiments' });
        expect(fetch.mock.calls[0][0]).toBe('https://panel.test/api/experiments');
        expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer t' });
        fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no writer' }), { status: 503 }));
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toMatchObject({ sent: false, reason: 'the panel answered 503: no writer' });
    });

    it('cannot say what was measured when the panel does not answer', async () => {
        process.env.KODUS_QUALITY_INGEST_TOKEN = 't';
        jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
        expect(await client.recordedExperiments('dedup', 'feat/x')).toBeNull();
    });
});
