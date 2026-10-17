import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STAGES, GROUPS, PLUMBING } = require('./stages');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wiringRows, nightlyRows, READERS, catalogPath, usageMeta } = require('./stage-signals');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { costUpperBound, catalogIdFor } = require('./investigation/nightly-compare');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadCatalog, catalogProblems } = require('./shared/eval-result');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tier0 } = require('./shared/tier0-models');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fridayKeys, tier0Signal, FEW_CASES } = require('./tier0-smoke');

type Stage = { id: string; name: string; group: string; eval: string | null; model: string; wiring: string[]; pipeline: string[] | null; nightly?: string; friday?: string; byHand?: string[] };
type Row = { name: string; status: string; value: number | null; meta: Record<string, unknown> };

// Steps of evals/wiring-smoke.js that check the harness, not a review stage.
const NOT_A_STAGE = ['preflight'];

const wiringSteps = Array.from(
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

describe('evals/stages.js', () => {
    it('gives every stage a unique id that makes a valid signal name', () => {
        const ids = STAGES.map((s: Stage) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(`evals.stage.${id}`).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/);
    });

    // The panel lists stages by group, one line each.
    it('gives every stage a short name and a group, with each group in one run', () => {
        for (const stage of STAGES as Stage[]) {
            expect(stage.name.length).toBeGreaterThan(0);
            expect(stage.name.length).toBeLessThanOrEqual(20);
            expect(GROUPS).toContain(stage.group);
        }
        const runs = (STAGES as Stage[]).map((s) => s.group).filter((g, i, all) => g !== all[i - 1]);
        expect(runs).toEqual(GROUPS);
    });

    // A new eval added to the wiring smoke without a stage would never reach the panel.
    it('claims every wiring smoke step, and names only steps that exist', () => {
        const claimed = STAGES.flatMap((s: Stage) => s.wiring);
        expect(wiringSteps.length).toBeGreaterThan(5);
        expect(wiringSteps.filter((step) => !claimed.includes(step) && !NOT_A_STAGE.includes(step))).toEqual([]);
        expect(claimed.filter((step: string) => !wiringSteps.includes(step))).toEqual([]);
    });

    // Adding a pipeline stage means saying how it is tested: a stage here, or plumbing.
    it('places every review pipeline stage in a stage or in PLUMBING, and nowhere else', () => {
        const staged = STAGES.flatMap((s: Stage) => s.pipeline || []);
        const plumbing = Object.keys(PLUMBING);
        expect(pipelineStages.length).toBeGreaterThan(10);
        expect(pipelineStages.filter((c) => !staged.includes(c) && !plumbing.includes(c))).toEqual([]);
        expect([...staged, ...plumbing].filter((c) => !pipelineStages.includes(c))).toEqual([]);
        expect(plumbing.filter((c) => staged.includes(c))).toEqual([]);
    });

    // The panel reads a Friday stage's outcome from this key of evals.tier0.<model>'s meta.
    it('names, for a Friday stage, a key the Friday check writes', () => {
        const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/code-review-evals-tier0.yml'), 'utf8');
        expect(workflow).toContain('tier0Signal(');
        const keys = (STAGES as Stage[]).filter((s) => s.friday).map((s) => s.friday as string);
        expect(keys.sort()).toEqual([...fridayKeys()].sort());
        const result = { status: 'pass', prSummary: { status: 'pass' }, evals: FEW_CASES.map((p: { key: string }) => ({ key: p.key, status: 'pass' })) };
        expect(Object.keys(tier0Signal(result).meta)).toEqual(expect.arrayContaining(keys));
    });

    // The nightly asks whether a change broke a stage on one model; Friday asks
    // whether the same stages still run on every tier-0 model.
    it('runs on Friday every stage the nightly measures', () => {
        const missing = (STAGES as Stage[]).filter((s) => s.nightly && !s.friday).map((s) => s.id);
        expect(missing).toEqual([]);
    });

    // The panel's "What it tests": every eval lists its cases, each with what it checks.
    it('gives every stage with an eval a catalog of its cases, read from its own data', () => {
        for (const stage of (STAGES as Stage[]).filter((s) => s.eval)) {
            const file = catalogPath(stage);
            expect([stage.id, fs.existsSync(path.join(__dirname, '..', file))]).toEqual([stage.id, true]);
            expect([stage.id, catalogProblems(loadCatalog(file))]).toEqual([stage.id, []]);
        }
        const posting = wiringRows(allOk(wiringSteps)).find((r: Row) => r.name === 'evals.stage.posting');
        expect(posting?.meta.case_catalog).toBeUndefined();
    });

    it('points every eval at a path that exists, and only "none" at no eval', () => {
        for (const stage of STAGES as Stage[]) {
            if (stage.model === 'none') expect(stage.eval).toBeNull();
            else expect(fs.existsSync(path.join(__dirname, '..', stage.eval as string))).toBe(true);
            for (const evalPath of stage.byHand ?? []) expect(fs.existsSync(path.join(__dirname, '..', evalPath))).toBe(true);
        }
    });
});

describe('stage-signals', () => {
    const scheduled = (STAGES as Stage[]).filter((s) => !s.nightly && s.wiring.length);

    it('reports every non-nightly stage from the wiring smoke, green when its steps pass', () => {
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        expect(rows.map((r) => r.name).sort()).toEqual(
            (STAGES as Stage[]).filter((s) => !s.nightly).map((s) => `evals.stage.${s.id}`).sort(),
        );
        for (const stage of scheduled) expect(rows.find((r) => r.name === `evals.stage.${stage.id}`)?.status).toBe('green');
    });

    it('marks a stage with no scheduled eval as skipped, with its note', () => {
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        const posting = rows.find((r) => r.name === 'evals.stage.posting');
        expect(posting?.status).toBe('skipped');
        expect(posting?.meta.note).toBe('no eval for this stage');
        expect(posting?.meta.order).toBe(STAGES.findIndex((s: Stage) => s.id === 'posting') + 1);
        expect(posting?.meta).toMatchObject({ name: 'Posting', group: 'On the PR' });
    });

    it('turns a failed step red and a step that did not run into infra', () => {
        const results = allOk(wiringSteps.filter((step) => step !== 'anchoring')).map((r) =>
            r.step === 'dedup-engine' ? { ...r, ok: false, problem: 'exit 1' } : r,
        );
        const rows: Row[] = wiringRows(results);
        const dedup = rows.find((r) => r.name === 'evals.stage.dedup');
        expect(dedup?.status).toBe('red');
        expect(dedup?.meta.reason).toBe('dedup-engine: exit 1');
        expect(rows.find((r) => r.name === 'evals.stage.anchoring')?.status).toBe('infra');
        expect(wiringRows(null).find((r: Row) => r.name === 'evals.stage.dedup')?.status).toBe('infra');
    });

    it('turns every wired stage into infra when the smoke fails a check no stage owns', () => {
        const results = [...allOk(wiringSteps), { step: 'pr-paths-filter', ok: false, problem: 'incomplete trace', ms: 0, calls: 0 }];
        const rows: Row[] = wiringRows(results);
        for (const stage of scheduled) expect(rows.find((r) => r.name === `evals.stage.${stage.id}`)?.status).toBe('infra');
        expect(rows.find((r) => r.name === 'evals.stage.dedup')?.meta).toMatchObject({
            reason: 'wiring smoke failed: pr-paths-filter: incomplete trace',
            harness: 'wiring smoke failed: pr-paths-filter: incomplete trace',
        });
        expect(rows.find((r) => r.name === 'evals.stage.posting')?.status).toBe('skipped');
        expect(wiringRows([...allOk(wiringSteps), { step: 'pr-paths-filter', ok: true, problem: null }]).find((r: Row) => r.name === 'evals.stage.dedup')?.status).toBe('green');
    });

    it("keeps a stage's own failure red on a night the smoke also failed its own check", () => {
        const results = [
            ...allOk(wiringSteps).map((r) => (r.step === 'dedup-engine' ? { ...r, ok: false, problem: 'exit 1' } : r)),
            { step: 'pr-paths-filter', ok: false, problem: 'incomplete trace', ms: 0, calls: 0 },
        ];
        const rows: Row[] = wiringRows(results);
        const dedup = rows.find((r) => r.name === 'evals.stage.dedup');
        expect(dedup?.status).toBe('red');
        expect(dedup?.meta).toMatchObject({ reason: 'dedup-engine: exit 1', failed: ['dedup-engine'], harness: 'wiring smoke failed: pr-paths-filter: incomplete trace' });
        expect(rows.find((r) => r.name === 'evals.stage.anchoring')?.status).toBe('infra');
    });

    it('reports the finder from the nightly: recall against the floor, status from the verdict', () => {
        const nightly = {
            model: 'deepseek-v4-flash@fireworks',
            cases: 30,
            unmeasured: 0,
            metrics: { recall_mean: 0.4, precision_mean: 0.5 },
            gate: { checks: [{ name: 'recall_mean', floor: 0.24 }], observed: { recall_mean: 0.357 } },
        };
        const [finder]: Row[] = nightlyRows(nightly, 'regression');
        expect(finder).toMatchObject({ name: 'evals.stage.finder', status: 'red', value: 0.4 });
        expect(finder.meta).toMatchObject({ floor: 0.24, baseline: 0.357, precision: 0.5 });
        expect(nightlyRows(nightly, 'pass')[0].status).toBe('green');
        expect(nightlyRows(null, 'infra')[0]).toMatchObject({ status: 'infra', value: null });
    });

    it('reports kody-rules from its own result: occurrence recall against its floor, with specificity and its cases', () => {
        // Made-up floors and levels: the real ones live only in evals/kody-rules/kody-targets.json.
        const result = {
            eval: 'kody-rules',
            question: 'Does the Kody Rules agent flag every place a rule is broken?',
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
        expect(row.meta).toMatchObject({ floor: 0.8, baseline: 0.93, specificity: 1, specificity_floor: 0.9, cases: 1, metric: 'of known rule violations flagged' });
        expect(row.meta.case_results).toEqual([{ id: 'n8n#1::no-console', checks: 'Flags every line that breaks "No console" in n8n#1', hits: 3, total: 4, detail: [{ what: 'a.ts:3', ok: false }] }]);
        expect(row.meta.caveat).toEqual(expect.stringContaining('mechanical rules only'));
        expect(nightlyRows(null, 'infra', 'kody-rules')[0]).toMatchObject({ status: 'infra', value: null });
        expect(nightlyRows(result, 'pass', 'finder')[0]).toMatchObject({ status: 'infra' });
    });

    it('reports what the model calls cost: per review of a case, call-time percentiles, no per-call times', () => {
        const tokens = { in: 4000, out: 400, cacheRead: 1000, cacheWrite: 0, calls: 8, ms: 8000, callMs: [500, 700, 800, 900, 1000, 1100, 1300, 1700] };
        const usage = usageMeta(tokens, 4, 'eval-fake');
        expect(usage).toEqual({
            calls: 8, in: 4000, out: 400, cacheRead: 1000, cacheWrite: 0, ms: 8000, p50Ms: 900, p95Ms: 1700, reviews: 4,
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

    it('gives every stage whose eval has a README the question that README answers', () => {
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        for (const stage of STAGES as Stage[]) {
            if (!stage.eval || !fs.existsSync(path.join(__dirname, '..', stage.eval, 'README.md'))) continue;
            const meta = stage.nightly ? nightlyRows({ metrics: { recall_mean: 0.4 }, metric: { value: 0.9 } }, 'pass', stage.id)[0].meta : rows.find((r) => r.name === `evals.stage.${stage.id}`)?.meta;
            expect([stage.id, meta?.question]).toEqual([stage.id, expect.stringMatching(/\?/)]);
        }
    });

    it('has a reader for every nightly-measured stage', () => {
        for (const stage of (STAGES as Stage[]).filter((s) => s.nightly)) expect(Object.keys(READERS)).toContain(stage.nightly);
    });

    it('lists the tier-0 models a Friday stage runs on, and no models for any other stage', () => {
        const nightly = { model: 'deepseek-v4-flash@fireworks', metrics: { recall_mean: 0.4 }, gate: {} };
        expect(nightlyRows(nightly, 'pass')[0].meta.friday).toEqual({ models: tier0(), result: 'review' });
        const shared = { metric: { value: 1 }, cases: [] };
        expect(nightlyRows(shared, 'pass', 'pr-summary')[0].meta.friday).toEqual({ models: tier0(), result: 'pr_summary' });
        const rows: Row[] = wiringRows(allOk(wiringSteps));
        expect(rows.find((r) => r.name === 'evals.stage.dedup')?.meta.friday).toBeUndefined();
    });
});
