import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STAGES, GROUPS, PLUMBING, unitSpecs } = require('./stages');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { testRows, nightlyRows, weeklyRows, weeklyTestRows, READERS, catalogPath, usageMeta } = require('./stage-signals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { costUpperBound, catalogIdFor } = require('./investigation/nightly-compare');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadCatalog, catalogProblems } = require('./shared/eval-result');

type Test = { kind: string; name: string; specs?: string[]; wiring?: string[]; weekly?: string[]; scenario?: string; signal?: string };
type Stage = { id: string; name: string; group: string; does: string; pipeline: string[] | null; tests: Test[]; eval: { path: string; nightly: string; sets: { controlled: string; full: string | null } } | null; note?: string };
type Row = { name: string; status: string; value: number | null; meta: Record<string, any> };

// Steps of evals/wiring-smoke.js that check the harness, not a review stage.
const NOT_A_STAGE = ['preflight'];

const smokeSteps = Array.from(
    fs.readFileSync(path.join(__dirname, 'wiring-smoke.js'), 'utf8').matchAll(/\bname: '([a-z-]+)'/g),
    (m) => m[1],
);

// The stages the review pipeline runs, read from its strategy's constructor.
const pipelineStages = Array.from(
    fs
        .readFileSync(path.join(__dirname, '../libs/code-review/pipeline/strategy/code-review-pipeline.strategy.ts'), 'utf8')
        .matchAll(/private readonly \w+: (\w+Stage)\b/g),
    (m) => m[1],
);

const allOk = (steps: string[]) => steps.map((step) => ({ step, ok: true, problem: null, ms: 1, calls: 1 }));
// A jest report where every unit spec of every stage passed (one test each).
const jestOk = (specs: string[] = unitSpecs()) => ({
    testResults: specs.map((spec) => ({ name: path.join('/work/kodus-ai', spec), status: 'passed', assertionResults: [{ status: 'passed', fullName: `${spec} works` }] })),
});
const stages = STAGES as Stage[];

describe('evals/stages.js', () => {
    it('gives every stage a unique id that makes a valid signal name', () => {
        const ids = stages.map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(`tests.stage.${id}`).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
    });

    // The panel lists stages by group, one line each, and says what each does.
    it('gives every stage a short name, a group with each group in one run, and what it does', () => {
        for (const stage of stages) {
            expect(stage.name.length).toBeGreaterThan(0);
            expect(stage.name.length).toBeLessThanOrEqual(20);
            expect(GROUPS).toContain(stage.group);
            expect([stage.id, stage.does.length > 20]).toEqual([stage.id, true]);
        }
        const runs = stages.map((s) => s.group).filter((g, i, all) => g !== all[i - 1]);
        expect(runs).toEqual(GROUPS);
    });

    // Every step shows on the panel with what tests it, even when no eval measures it.
    it('gives every stage at least one test, each of a known kind with what it runs', () => {
        for (const stage of stages) {
            expect([stage.id, stage.tests.length > 0]).toEqual([stage.id, true]);
            for (const t of stage.tests) {
                expect(['unit', 'contract', 'e2e']).toContain(t.kind);
                expect(t.name.length).toBeGreaterThan(0);
                if (t.kind === 'unit') expect([stage.id, (t.specs || []).length > 0]).toEqual([stage.id, true]);
                if (t.kind === 'contract') expect([stage.id, Boolean(t.wiring?.length || t.weekly?.length)]).toEqual([stage.id, true]);
                if (t.kind === 'e2e') expect([stage.id, fs.existsSync(path.join(__dirname, '..', t.scenario as string)), t.signal]).toEqual([stage.id, true, expect.stringMatching(/^e2e\./)]);
            }
        }
    });

    it('names unit specs that exist, and wiring smoke steps that exist', () => {
        expect(unitSpecs().filter((f: string) => !fs.existsSync(path.join(__dirname, '..', f)))).toEqual([]);
        const claimed = stages.flatMap((s) => s.tests.flatMap((t) => t.wiring || []));
        expect(smokeSteps.length).toBeGreaterThan(5);
        // A new eval added to the wiring smoke without a stage would never reach the panel.
        expect(smokeSteps.filter((step) => !claimed.includes(step) && !NOT_A_STAGE.includes(step))).toEqual([]);
        expect(claimed.filter((step) => !smokeSteps.includes(step))).toEqual([]);
    });

    // Adding a pipeline stage means saying how it is tested: a stage here, or plumbing.
    it('places every review pipeline stage in a stage or in PLUMBING, and nowhere else', () => {
        const staged = stages.flatMap((s) => s.pipeline || []);
        const plumbing = Object.keys(PLUMBING);
        expect(pipelineStages.length).toBeGreaterThan(10);
        expect(pipelineStages.filter((c) => !staged.includes(c) && !plumbing.includes(c))).toEqual([]);
        expect([...staged, ...plumbing].filter((c) => !pipelineStages.includes(c))).toEqual([]);
        expect(plumbing.filter((c) => staged.includes(c))).toEqual([]);
    });

    // The panel's "What it tests": every eval lists its cases, each with what it checks.
    it('gives every eval a folder, a reader and a catalog of its cases read from its own data', () => {
        for (const stage of stages.filter((s) => s.eval)) {
            const e = stage.eval!;
            expect([stage.id, fs.existsSync(path.join(__dirname, '..', e.path))]).toEqual([stage.id, true]);
            expect(Object.keys(READERS)).toContain(e.nightly);
            expect([stage.id, typeof e.sets.controlled]).toEqual([stage.id, 'string']);
            const file = catalogPath(stage);
            expect([stage.id, fs.existsSync(path.join(__dirname, '..', file.split('#')[0]))]).toEqual([stage.id, true]);
            expect([stage.id, catalogProblems(loadCatalog(file))]).toEqual([stage.id, []]);
        }
    });

    it('says why a stage has no eval, when a test stands in for one', () => {
        for (const id of ['parse', 'anchoring', 'pr-summary', 'analyzers']) {
            const stage = stages.find((s) => s.id === id)!;
            expect([id, stage.eval, Boolean(stage.note)]).toEqual([id, null, true]);
        }
    });
});

describe('stage-signals: tests.stage rows', () => {
    it('writes one row per stage, green when its unit specs and contract steps pass', () => {
        const rows: Row[] = testRows({ wiring: allOk(smokeSteps), jest: jestOk() });
        expect(rows.map((r) => r.name).sort()).toEqual(stages.map((s) => `tests.stage.${s.id}`).sort());
        for (const row of rows) expect([row.name, row.status]).toEqual([row.name, 'green']);
    });

    it('carries what the stage is: what it does, its tests with their outcome, and its eval', () => {
        const rows: Row[] = testRows({ wiring: allOk(smokeSteps), jest: jestOk() });
        const finder = rows.find((r) => r.name === 'tests.stage.finder')!;
        expect(finder.meta).toMatchObject({ stage: 'finder', name: 'Finder', group: 'The agents, side by side', order: stages.findIndex((s) => s.id === 'finder') + 1 });
        expect(finder.meta.does).toEqual(expect.stringContaining('looks for bugs'));
        expect(finder.meta.tests.map((t: { kind: string; status: string }) => [t.kind, t.status])).toEqual([['unit', 'pass'], ['contract', 'pass']]);
        expect(finder.meta.tests[0]).toMatchObject({ passed: 5, total: 5 });
        expect(finder.meta.eval).toMatchObject({ path: 'evals/investigation', metric: 'of known bugs found', question: expect.stringMatching(/\?/) });
        expect(finder.meta.case_catalog.length).toBe(15);
        // A stage tested only: no eval, its note, no catalog.
        const parse = rows.find((r) => r.name === 'tests.stage.parse')!;
        expect(parse.meta.eval).toBeNull();
        expect(parse.meta.note).toEqual(expect.stringContaining('Tests only'));
        expect(parse.meta.case_catalog).toBeUndefined();
        // Tests another job reports keep their kind and say who reports them.
        const summary = rows.find((r) => r.name === 'tests.stage.pr-summary')!;
        expect(summary.meta.tests.map((t: { status: string }) => t.status)).toEqual(['pass', 'pass', 'weekly']);
        const files = rows.find((r) => r.name === 'tests.stage.rules-from-files')!;
        expect(files.meta.tests[1]).toMatchObject({ kind: 'e2e', status: 'elsewhere', signal: 'e2e.selfhosted.matrix' });
    });

    it('turns a failing unit test or contract step red, naming it, and one that did not run into infra', () => {
        const spec = 'libs/code-review/infrastructure/agents/core/finder.agent.spec.ts';
        const jest = jestOk();
        const at = jest.testResults.findIndex((t) => t.name.endsWith(spec));
        jest.testResults[at] = { ...jest.testResults[at], status: 'failed', assertionResults: [{ status: 'failed', fullName: 'finder keeps its tools' }] };
        const red: Row = testRows({ wiring: allOk(smokeSteps), jest }).find((r: Row) => r.name === 'tests.stage.finder');
        expect(red.status).toBe('red');
        expect(red.meta.tests[0]).toMatchObject({ status: 'fail', failures: [{ spec, test: 'finder keeps its tools' }] });
        expect(red.meta.reason).toEqual(expect.stringContaining('finder keeps its tools'));

        const failedStep = allOk(smokeSteps).map((r) => (r.step === 'finder-recall' ? { ...r, ok: false, problem: 'exit 1' } : r));
        const step: Row = testRows({ wiring: failedStep, jest: jestOk() }).find((r: Row) => r.name === 'tests.stage.finder');
        expect(step.status).toBe('red');
        expect(step.meta.tests[1]).toMatchObject({ status: 'fail', problem: 'finder-recall: exit 1' });

        const noJest: Row = testRows({ wiring: allOk(smokeSteps), jest: null }).find((r: Row) => r.name === 'tests.stage.finder');
        expect(noJest.status).toBe('infra');
        expect(noJest.meta.tests[0]).toMatchObject({ status: 'not-run' });
        const missingStep: Row = testRows({ wiring: allOk(smokeSteps.filter((s) => s !== 'finder-recall')), jest: jestOk() }).find((r: Row) => r.name === 'tests.stage.finder');
        expect(missingStep.status).toBe('infra');
    });

    it('turns every stage into infra when the smoke fails a check no stage owns, keeping a red one red', () => {
        const results = [...allOk(smokeSteps), { step: 'pr-paths-filter', ok: false, problem: 'incomplete trace', ms: 0, calls: 0 }];
        const rows: Row[] = testRows({ wiring: results, jest: jestOk() });
        expect(rows.find((r) => r.name === 'tests.stage.dedup')).toMatchObject({ status: 'infra', meta: { harness: 'wiring smoke failed: pr-paths-filter: incomplete trace' } });
        const both = results.map((r) => (r.step === 'funnel-dedup' ? { ...r, ok: false, problem: 'exit 1' } : r));
        expect(testRows({ wiring: both, jest: jestOk() }).find((r: Row) => r.name === 'tests.stage.dedup')?.status).toBe('red');
    });
});

describe('stage-signals: eval rows', () => {
    it('reports the finder from the nightly: recall against the floor, status from the verdict', () => {
        const nightly = {
            model: 'deepseek-v4-flash@fireworks',
            cases: 15,
            unmeasured: 0,
            metrics: { recall_mean: 0.4, precision_mean: 0.5 },
            gate: { checks: [{ name: 'recall_mean', floor: 0.24 }], observed: { recall_mean: 0.357 } },
        };
        const [finder]: Row[] = nightlyRows(nightly, 'regression');
        expect(finder).toMatchObject({ name: 'evals.stage.finder', status: 'red', value: 0.4 });
        expect(finder.meta).toMatchObject({ floor: 0.24, baseline: 0.357, precision: 0.5, tier: 'nightly', set: 'controlled', stage: 'finder' });
        expect(finder.meta.eval).toMatchObject({ path: 'evals/investigation' });
        expect(nightlyRows(nightly, 'pass')[0].status).toBe('green');
        expect(nightlyRows(null, 'infra')[0]).toMatchObject({ status: 'infra', value: null });
        // A stage with no eval has no eval row.
        expect(nightlyRows({ metric: { value: 1 } }, 'pass', 'parse')).toEqual([]);
    });

    it('reports kody-rules from its own result: occurrence recall against its floor, with specificity and its cases', () => {
        // Made-up floors and levels: the real ones live only in evals/kody-rules/kody-targets.json.
        const result = {
            eval: 'kody-rules',
            model: 'deepseek-v4-flash@fireworks',
            runs: 2,
            metric: { name: 'occurrence recall', value: 0.7, floor: 0.8, baseline: 0.93 },
            specificity: { value: 1, floor: 0.9, baseline: 1 },
            linePrecision: 0.9,
            counts: { sites: 86 },
            cases: [{ id: 'n8n#1::no-console', checks: 'Flags every line that breaks "No console" in n8n#1', hits: 3, total: 4, detail: [{ what: 'a.ts:3', ok: false }] }],
            tokens: { in: 10, out: 1 },
            infra: { errored: 0, total: 28 },
        };
        const [row]: Row[] = nightlyRows(result, 'regression', 'kody-rules');
        expect(row).toMatchObject({ name: 'evals.stage.kody-rules', status: 'red', value: 0.7 });
        expect(row.meta).toMatchObject({ floor: 0.8, baseline: 0.93, specificity: 1, specificity_floor: 0.9, cases: 1 });
        expect(row.meta.eval).toMatchObject({ metric: 'of known rule violations flagged', caveat: expect.stringContaining('mechanical rules only') });
        expect(row.meta.case_results).toEqual([{ id: 'n8n#1::no-console', checks: 'Flags every line that breaks "No console" in n8n#1', hits: 3, total: 4, detail: [{ what: 'a.ts:3', ok: false }] }]);
        expect(nightlyRows(null, 'infra', 'kody-rules')[0]).toMatchObject({ status: 'infra', value: null });
        expect(nightlyRows(result, 'pass', 'finder')[0]).toMatchObject({ status: 'infra' });
    });

    it('reports a weekly measure per stage, set and model, its id folded into the name like report-signal does', () => {
        const result = { model: 'kimi-k2.7-code@openrouter', metric: { value: 0.9, floor: 0.85, baseline: 0.93 }, runs: 1, cases: [{ id: 'a', checks: 'Checks a', hits: 1, total: 1 }], tokens: { in: 1, out: 1 } };
        const [row]: Row[] = weeklyRows(result, 'pass', { stageId: 'conversation', model: 'kimi-k2.7-code@openrouter', set: 'controlled' });
        expect(row).toMatchObject({ name: 'evals.weekly.conversation.controlled.kimi-k2.7-code_openrouter', status: 'green', value: 0.9 });
        expect(row.meta).toMatchObject({ stage: 'conversation', tier: 'weekly', set: 'controlled', model: 'kimi-k2.7-code@openrouter', floor: 0.85, verdict: 'pass' });
        expect(row.meta.case_catalog).toBeUndefined();
        expect(weeklyRows(result, 'ungated', { stageId: 'conversation', model: 'm', set: 'controlled' })[0].status).toBe('yellow');
        expect(weeklyRows(null, 'infra', { stageId: 'finder', model: 'm', set: 'full' })[0]).toMatchObject({ name: 'evals.weekly.finder.full.m', status: 'infra' });
        expect(weeklyRows(result, 'pass', { stageId: 'parse', model: 'm', set: 'controlled' })).toEqual([]);
    });

    it('reports a weekly contract test per model: green on exit 0, red on 1, infra otherwise', () => {
        const at = (exit: number) => weeklyTestRows({ stageId: 'pr-summary', model: 'gpt-6-sol', exit, problem: exit ? `exit ${exit}` : null })[0];
        expect(at(0)).toMatchObject({ name: 'tests.weekly.pr-summary.gpt-6-sol', status: 'green', meta: { stage: 'pr-summary', model: 'gpt-6-sol', tier: 'weekly', kind: 'contract' } });
        expect(at(1)).toMatchObject({ status: 'red', meta: { reason: 'exit 1' } });
        expect(at(2).status).toBe('infra');
        expect(weeklyTestRows({ stageId: 'finder', model: 'm', exit: 0 })).toEqual([]);
    });

    it('reports what the model calls cost: per review of a case, cache hits, call-time percentiles, no per-call times', () => {
        const tokens = { in: 4000, out: 400, cacheRead: 1000, cacheWrite: 0, calls: 8, ms: 8000, callMs: [500, 700, 800, 900, 1000, 1100, 1300, 1700] };
        const usage = usageMeta(tokens, 4, 'eval-fake');
        expect(usage).toEqual({
            calls: 8, in: 4000, out: 400, cacheRead: 1000, cacheWrite: 0, cacheHit: 0.25, ms: 8000, p50Ms: 900, p95Ms: 1700, reviews: 4,
            perCase: { calls: 2, in: 1000, out: 100, cacheRead: 250, cacheWrite: 0, ms: 2000 },
            usdPerCaseMax: null,
        });
        // Priced only from the Kodus catalog, every input token at the full rate.
        const priced = usageMeta(tokens, 4, 'deepseek-v4-flash@fireworks');
        expect(priced.usdPerCaseMax).toBeCloseTo(costUpperBound({ prompt: 4000, completion: 400 }, catalogIdFor('deepseek-v4-flash@fireworks')) / 4);
        expect(priced.usdPerCaseMax).toBeGreaterThan(0);
        expect(usageMeta(null, 4, 'eval-fake')).toBeNull();
        expect(usageMeta({ in: 10 }, 0, 'eval-fake')).toMatchObject({ calls: 0, p50Ms: null, perCase: null });

        // The shared reader: usage for the panel, the tokens without per-call times.
        const result = {
            eval: 'demo', question: 'Does it?', model: 'eval-fake', runs: 2,
            metric: { name: 'of cases right', value: 1 },
            cases: [{ id: 'a', checks: 'Checks a', hits: 1, total: 1 }, { id: 'b', checks: 'Checks b', hits: 1, total: 1 }],
            tokens,
        };
        const read = READERS.shared(result);
        expect(read.extra.tokens).toEqual({ in: 4000, out: 400, cacheRead: 1000, cacheWrite: 0, calls: 8, ms: 8000 });
        expect(read.extra.usage).toMatchObject({ reviews: 4, perCase: { calls: 2, ms: 2000 } });
        // The finder: summary.usage, two runs of every case on a confirmed night.
        const finder = { model: 'eval-fake', cases: 2, metrics: { recall_mean: 0.4 }, gate: { confirmation: { runs: [0.4, 0.4] } }, usage: tokens, rows: [] };
        expect(READERS['finder-recall'](finder).extra.usage).toMatchObject({ reviews: 4, perCase: { in: 1000 } });
    });

    it("reports the finder's cases: each PR's known bugs, found or not, by the PR's title", () => {
        const datasets = path.join(__dirname, 'investigation', 'datasets');
        const file = fs.readdirSync(datasets).find((f) => f.endsWith('.json')) as string;
        const data = JSON.parse(fs.readFileSync(path.join(datasets, file), 'utf8'));
        const { caseId, prTitle } = (Array.isArray(data) ? data[0] : data).vars;
        const nightly = {
            model: 'deepseek-v4-flash@fireworks',
            metrics: { recall_mean: 0.4 },
            gate: {},
            rows: [
                { caseId, metadata: { goldens: 2, matched: 1, goldenResults: [{ golden: 'bug A', found: true }, { golden: 'bug B', found: false }] } },
                { caseId: 'did-not-run', status: 'infra' },
            ],
        };
        const [finder]: Row[] = nightlyRows(nightly, 'pass');
        expect(finder.meta.case_results).toEqual([
            { id: caseId, checks: `Finds the known bugs in "${prTitle}"`, hits: 1, total: 2, detail: [{ what: 'bug A', ok: true }, { what: 'bug B', ok: false }] },
            { id: 'did-not-run', checks: 'Finds the known bugs in "did-not-run"', hits: 0, total: 0, unmeasured: true },
        ]);
        // A confirmed night: a bug counts as found when either run found it, and
        // the count follows the bugs shown, not the first run's `matched`.
        const confirmed = { ...nightly, rows: [{ caseId, metadata: { goldens: 2, matched: 1, goldenResults: [{ golden: 'bug A', found: true }, { golden: 'bug B', found: true }] } }] };
        expect(nightlyRows(confirmed, 'pass')[0].meta.case_results[0]).toMatchObject({ hits: 2, total: 2 });
    });

    it('gives every eval the question its README answers', () => {
        const rows: Row[] = testRows({ wiring: allOk(smokeSteps), jest: jestOk() });
        for (const stage of stages.filter((s) => s.eval)) {
            const meta = rows.find((r) => r.name === `tests.stage.${stage.id}`)?.meta;
            expect([stage.id, meta?.eval?.question]).toEqual([stage.id, expect.stringMatching(/\?/)]);
        }
    });
});
