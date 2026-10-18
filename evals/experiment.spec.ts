import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compare, comparisonOf, decide, phaseVerdict, affectedSteps } = require('./experiment');

// Every temporary folder a test makes, removed when the file is done.
const made: string[] = [];
const tmpDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    made.push(dir);
    return dir;
};
afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
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

    it('one model and several at once, or a list with a model outside tier0-models.js', async () => {
        expect(await run(['--step=finder', '--model=deepseek-v4-flash@fireworks', '--models=deepseek-v4-flash@fireworks'])).toMatchObject({ code: 2, said: expect.stringContaining('not both') });
        expect(await run(['--step=finder', '--models=deepseek-v4-flash@fireworks,gpt-unknown'])).toMatchObject({ code: 2, said: expect.stringContaining('gpt-unknown') });
    });

    it('a set the step does not have, or the regression phase\'s own', async () => {
        expect(await run(['--step=dedup', '--set=dependencies'])).toMatchObject({ code: 2, said: expect.stringContaining('no sets of its own') });
        expect(await run(['--step=finder', '--set=no-such-set'])).toMatchObject({ code: 2, said: expect.stringContaining("no set 'no-such-set'") });
        expect(await run(['--step=finder', '--set=controlled'])).toMatchObject({ code: 2, said: expect.stringContaining("regression phase's own set") });
    });

    it('a team config an eval of the step does not take, or a file that is not one', async () => {
        const file = path.join(tmpDir('team-'), 'config.json');
        fs.writeFileSync(file, JSON.stringify({ reviewMode: 'heavy' }));
        expect(await run(['--step=dedup', `--team-config=${file}`])).toMatchObject({ code: 2, said: expect.stringContaining('does not take a team config') });
        expect(await run(['--step=finder', '--team-config=/nonexistent/config.json'])).toMatchObject({ code: 2, said: expect.stringContaining('not a readable JSON') });
    });
});

describe('evals/experiment.js sets', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setOf, STEP_EVALS } = require('./experiment');

    it('runs "is it better?" on the extended set unless told otherwise', () => {
        expect(setOf(STEP_EVALS.dedup, undefined)).toEqual({ id: 'full', args: ['--set=full'] });
        expect(setOf(STEP_EVALS.finder, 'full')).toEqual({ id: 'full', args: ['--set=full'] });
    });

    it('records a private set by its content, never by where it sits', () => {
        const dir = tmpDir('verify-prod-');
        fs.writeFileSync(path.join(dir, 'a.json'), '{"x":1}');
        const first = setOf(STEP_EVALS.finder, dir);
        expect(first).toMatchObject({ id: `private:${path.basename(dir).toLowerCase()}`, args: [`--set=${dir}`], private: true });
        fs.writeFileSync(path.join(dir, 'a.json'), '{"x":2}');
        expect(setOf(STEP_EVALS.finder, dir).hash).not.toBe(first.hash);
    });
});

describe('evals/experiment.js the finder', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { finderResult, deriveRuns, STEP_EVALS } = require('./experiment');
    const raw = {
        judge: 'gpt-x',
        metrics: { recall_mean: 0.5 },
        usage: { in: 10, out: 2, cacheRead: 0, cacheWrite: 0, calls: 1, ms: 5, callMs: [5] },
        teamConfig: { hash: 'h', configs: { k: 1 } },
        rows: [
            { caseId: 'p', metadata: { goldens: 2, matched: 1, fpFindings: 3, goldenResults: [{ golden: 'a', found: true }, { golden: 'b', found: false }] } },
            { caseId: 'c', metadata: { control: true, goldens: 0, matched: 0, fpFindings: 1, goldenResults: [] } },
            { caseId: 'x', metadata: {} },
        ],
    };

    it("reads run-recall's result as cases of known bugs shipped, with the judge and team config it ran", () => {
        const r = finderResult(raw);
        expect(r).toMatchObject({ metric: { value: 0.5 }, tokens: raw.usage, environment: { judge: 'gpt-x' }, teamConfig: raw.teamConfig });
        expect(r.cases.map((c: Case) => [c.id, c.hits, c.total, Boolean(c.unmeasured)])).toEqual([['p', 1, 2, false], ['c', 0, 0, false], ['x', 0, 0, true]]);
        expect(finderResult({ rows: [] })).toBeNull();
    });

    it('measures what it shipped right: known bugs over everything shipped, a control counting only noise', () => {
        const [precision] = STEP_EVALS.finder.primary.derived;
        const [run] = deriveRuns([finderResult(raw)], precision);
        expect(run.cases.map((c: Case) => [c.id, c.hits, c.total])).toEqual([['p', 1, 4], ['c', 0, 1]]);
    });

    it('never runs on a PR check: every case is a full review', () => {
        expect(STEP_EVALS.finder.smoke).toEqual([]);
    });
});

describe('evals/experiment.js team config and several models', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decideAcrossModels, measureEach } = require('./experiment');
    const m = (model: string, regression: string, decision: string | null, ships: string, worse?: boolean) => ({ model, verdicts: decision ? { regression, decision } : { regression }, decision: { decision: ships, reason: '', ...(worse === undefined ? {} : { worse }) } });

    it('compares one commit with the team config off and on: an unchanged step is the point', () => {
        const same = { base: { step: 'x' }, candidate: { step: 'x' } };
        const primary = { id: 'p', role: 'primary', comparison: { verdict: 'better', worse: [] }, sides: { base: { usage: {} }, candidate: { usage: {} } } };
        const phases = { regression: { verdict: 'no regression', evals: [primary] }, decision: { verdict: 'better', evals: [primary] } };
        expect(decide(phases, same).decision).toBe('no change in this step');
        expect(decide(phases, same, { sameCode: true }).decision).toBe('ships');
    });

    it('ships across models only when none got worse and one is better', () => {
        expect(decideAcrossModels([m('a', 'no regression', 'better', 'ships'), m('b', 'no regression', 'tie', 'does not ship')])).toMatchObject({ decision: 'ships', reason: 'better on a, no worse on b' });
        expect(decideAcrossModels([m('a', 'no regression', 'better', 'ships'), m('b', 'regression', 'tie', 'does not ship')])).toMatchObject({ decision: 'does not ship', reason: 'worse on b' });
        expect(decideAcrossModels([m('a', 'no regression', 'better', 'ships'), m('b', 'no regression', 'worse', 'does not ship')]).decision).toBe('does not ship');
        // better, but a guard of the decision phase got worse
        expect(decideAcrossModels([m('a', 'no regression', 'better', 'does not ship')]).decision).toBe('does not ship');
        expect(decideAcrossModels([m('a', 'no regression', 'tie', 'does not ship'), m('b', 'no regression', 'tie', 'does not ship')])).toMatchObject({ decision: 'does not ship', reason: 'better on no model' });
        expect(decideAcrossModels([m('a', 'no regression', null, 'no regression'), m('b', 'no regression', null, 'no regression')]).decision).toBe('no regression');
        expect(decideAcrossModels([m('a', 'not measured', null, 'not measured'), m('b', 'regression', null, 'does not ship')]).decision).toBe('not measured');
    });

    it('vetoes a model whose guard got worse while its main eval tied', () => {
        // decide() says so with `worse`; "tie and not cheaper" alone is not worse
        expect(decideAcrossModels([m('a', 'no regression', 'tie', 'does not ship', true), m('b', 'no regression', 'better', 'ships', false)])).toMatchObject({ decision: 'does not ship', reason: 'worse on a' });
        expect(decideAcrossModels([m('a', 'no regression', 'tie', 'does not ship', false), m('b', 'no regression', 'better', 'ships', false)]).decision).toBe('ships');
    });

    it('measures each model on its own: one that fails is not measured, the others still count', async () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const done = await measureEach(['a', 'b', 'c'], async (model: string) => {
                if (model === 'b') throw new Error('quota');
                return m(model, 'no regression', 'better', 'ships', false);
            }, { step: 'finder', nameOf: (model: string) => `run-${model}` });
            expect(done.map((d: { model: string; decision: { decision: string } }) => [d.model, d.decision.decision])).toEqual([['a', 'ships'], ['b', 'not measured'], ['c', 'ships']]);
            expect(decideAcrossModels(done)).toMatchObject({ decision: 'not measured', reason: 'not measured on b' });
        } finally {
            error.mockRestore();
        }
    });
});

describe('evals/experiment.js base-side reuse', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { reusableBase, keepBase, reviewEnv, BASE_REUSE_DAYS } = require('./experiment');

    it('keys a run on the environment that changes what it measures, never on keys or URLs', () => {
        expect(reviewEnv({ RECALL_CATEGORIES: 'bug', JUDGE_MODEL: 'j', JUDGE_REASONING_EFFORT: 'low', JUDGE_API_KEY: 'secret', JUDGE_BASE_URL: 'http://x', RECALL_DUMP: '1', PATH: '/bin' })).toEqual({
            JUDGE_MODEL: 'j',
            JUDGE_REASONING_EFFORT: 'low',
            RECALL_CATEGORIES: 'bug',
        });
    });
    const parts = { eval: 'finder-recall', args: ['--set=controlled'], model: 'm', round: 1, evals: 't', lock: 'l', set: null };
    const rec = { savedAt: '2026-10-10T00:00:00.000Z', baseSha: 'b', traced: ['libs/a.ts', 'evals/x.js'], prodBlobs: { 'libs/a.ts': 'a1' }, result: { cases: [] } };
    const at = (iso: string) => Date.parse(iso);

    it('reuses a base run on the same code, eval, arguments, model, round, evals and lockfile', () => {
        const dir = tmpDir('base-');
        keepBase(dir, parts, rec);
        expect(reusableBase(dir, parts, () => ({ 'libs/a.ts': 'a1' }), at('2026-10-12T00:00:00Z'))).toEqual(rec);
        expect(reusableBase(dir, { ...parts, round: 2 }, () => ({ 'libs/a.ts': 'a1' }), at('2026-10-12T00:00:00Z'))).toBeNull();
        expect(reusableBase(dir, { ...parts, lock: 'l2' }, () => ({ 'libs/a.ts': 'a1' }), at('2026-10-12T00:00:00Z'))).toBeNull();
    });

    it('runs it again when a production file it loaded changed, or after the reuse window', () => {
        const dir = tmpDir('base-');
        keepBase(dir, parts, rec);
        expect(reusableBase(dir, parts, () => ({ 'libs/a.ts': 'a2' }), at('2026-10-12T00:00:00Z'))).toBeNull();
        const late = at(rec.savedAt) + (BASE_REUSE_DAYS + 1) * 86_400_000;
        expect(reusableBase(dir, parts, () => ({ 'libs/a.ts': 'a1' }), late)).toBeNull();
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
    const blobs = { base: { 'libs/a.ts': 'a1', 'libs/b.ts': 'b1' }, candidate: { 'libs/a.ts': 'a2', 'libs/b.ts': 'b1' } };
    const record = { experiment: 'x', model: 'm', runs: 2, evals_tree: 't1', phases: ['regression', 'decision'], phase_verdicts: { regression: 'no regression', decision: 'better' }, step_blobs: blobs };
    const ask = { phaseIds: ['regression'], model: 'm', runs: 2, evalsTree: 't1' };
    const blobsOf = (now: Record<string, Record<string, string>>) => (side: string, files: string[]) => Object.fromEntries(files.map((f) => [f, now[side][f]]));
    const same = blobsOf(blobs);

    it('finds the experiment that measured exactly this, on the same model, runs and evals', () => {
        expect(measuredAlready([record], ask, same)).toBe(record);
    });

    it('runs again when a step file differs on either side', () => {
        expect(measuredAlready([record], ask, blobsOf({ base: blobs.base, candidate: { ...blobs.candidate, 'libs/a.ts': 'a3' } }))).toBeNull();
        expect(measuredAlready([record], ask, blobsOf({ base: { ...blobs.base, 'libs/b.ts': 'b9' }, candidate: blobs.candidate }))).toBeNull();
    });

    it('runs again for another model, run count or evals, or a record without them', () => {
        expect(measuredAlready([record], { ...ask, model: 'other' }, same)).toBeNull();
        expect(measuredAlready([record], { ...ask, runs: 3 }, same)).toBeNull();
        expect(measuredAlready([record], { ...ask, evalsTree: 't2' }, same)).toBeNull();
        expect(measuredAlready([{ ...record, evals_tree: null }], ask, same)).toBeNull();
    });

    it('matches the set and team config it recorded; a record from before them measured the extended set with none', () => {
        const recorded = { ...record, reuse: { model: 'm', runs: 2, evals_tree: 't1', set: 'dependencies', team_config_hash: 'h1' } };
        expect(measuredAlready([recorded], { ...ask, set: 'dependencies', teamConfigHash: 'h1' }, same)).toBe(recorded);
        expect(measuredAlready([recorded], { ...ask, set: 'dependencies', teamConfigHash: null }, same)).toBeNull();
        expect(measuredAlready([recorded], ask, same)).toBeNull();
        expect(measuredAlready([record], { ...ask, set: 'dependencies' }, same)).toBeNull();
        expect(measuredAlready([record], { ...ask, teamConfigHash: 'h1' }, same)).toBeNull();
    });

    it('matches a private set by its content and the review environment it ran in', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { setIdentity, envHashOf } = require('./experiment');
        const cases = setIdentity({ id: 'private:verify-prod', private: true, hash: 'c1' });
        const recorded = { ...record, reuse: { model: 'm', runs: 2, evals_tree: 't1', set: cases, team_config_hash: null, env: envHashOf({ JUDGE_MODEL: 'j1' }) } };
        expect(measuredAlready([recorded], { ...ask, set: cases, env: envHashOf({ JUDGE_MODEL: 'j1' }) }, same)).toBe(recorded);
        expect(measuredAlready([recorded], { ...ask, set: setIdentity({ id: 'private:verify-prod', private: true, hash: 'c2' }), env: envHashOf({ JUDGE_MODEL: 'j1' }) }, same)).toBeNull();
        expect(measuredAlready([recorded], { ...ask, set: cases, env: envHashOf({ JUDGE_MODEL: 'j2' }) }, same)).toBeNull();
    });

    it('never reuses a phase that was not asked, not answered or not measured', () => {
        expect(measuredAlready([{ ...record, phases: ['regression'] }], { ...ask, phaseIds: ['regression', 'decision'] }, same)).toBeNull();
        expect(measuredAlready([{ ...record, phase_verdicts: { regression: 'not measured' } }], ask, same)).toBeNull();
        expect(measuredAlready([{ ...record, phase_verdicts: {} }], ask, same)).toBeNull();
    });
});

describe('evals/shared/quality-client.js', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const client = require('./shared/quality-client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
        jest.restoreAllMocks();
    });

    it('does not send without a secret, and says why', async () => {
        delete process.env.KODUS_QUALITY_INGEST_TOKEN;
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toMatchObject({ sent: false, reason: expect.stringContaining('KODUS_QUALITY_INGEST_TOKEN') });
    });

    it('signs each request instead of sending the secret, and reports a refusal without throwing', async () => {
        process.env.KODUS_QUALITY_INGEST_TOKEN = 'the-secret';
        process.env.KODUS_QUALITY_URL = 'https://panel.test/';
        const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ inserted: 1 }), { status: 200 }));
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toEqual({ sent: true, url: 'https://panel.test/experiments' });
        const [url, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
        expect(url).toBe('https://panel.test/api/experiments');
        expect(JSON.stringify(init.headers)).not.toContain('the-secret');
        const ts = init.headers['x-kodus-timestamp'];
        const bodyHash = crypto.createHash('sha256').update(init.body).digest('hex');
        expect(init.headers['x-kodus-signature']).toBe(`sha256=${crypto.createHmac('sha256', 'the-secret').update(`POST\n/api/experiments\n${ts}\n${bodyHash}`).digest('hex')}`);
        fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no writer' }), { status: 503 }));
        expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toMatchObject({ sent: false, reason: 'the panel answered 503: no writer' });
    });

    it('refuses a panel URL that is not a bare https origin before any secret is used', async () => {
        process.env.KODUS_QUALITY_INGEST_TOKEN = 'the-secret';
        const fetch = jest.spyOn(globalThis, 'fetch');
        for (const bad of ['http://panel.test', 'https://panel.test/other', 'https://panel.test/?x=1', 'https://user:pw@panel.test', 'ftp://panel.test']) {
            process.env.KODUS_QUALITY_URL = bad;
            expect(await client.sendExperimentRows([{ name: 'experiments.x' }])).toMatchObject({ sent: false, reason: expect.stringContaining('KODUS_QUALITY_URL') });
        }
        expect(fetch).not.toHaveBeenCalled();
        process.env.KODUS_QUALITY_URL = 'http://localhost:3777';
        expect(client.panelOrigin()).toBe('http://localhost:3777');
    });

    it('cannot say what was measured when the panel does not answer', async () => {
        process.env.KODUS_QUALITY_INGEST_TOKEN = 'the-secret';
        delete process.env.KODUS_QUALITY_URL;
        jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
        expect(await client.recordedExperiments('dedup', 'feat/x')).toBeNull();
    });
});

describe('evals/experiment.js run names', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runName } = require('./experiment');

    const at = new Date('2026-10-17T21:46:33.120Z');

    it('names a run after its branch, candidate commit and start, so two runs never share rows', () => {
        expect(runName('feat/dedup-v2', '896fa156c1234', at, 'a1b2c3')).toBe('feat-dedup-v2-896fa156c-20261017214633-a1b2c3');
        expect(runName('feat/dedup-v2', '27c191cd7aaaa', at, 'a1b2c3')).not.toBe(runName('feat/dedup-v2', '896fa156c1234', at, 'a1b2c3'));
    });

    it('keeps two runs at the same commit apart, even when they start in the same second', () => {
        const later = new Date(at.getTime() + 60_000);
        expect(runName('feat/dedup-v2', '896fa156c1234', later)).not.toBe(runName('feat/dedup-v2', '896fa156c1234', at));
        expect(runName('feat/dedup-v2', '896fa156c1234', at)).not.toBe(runName('feat/dedup-v2', '896fa156c1234', at));
    });
});
