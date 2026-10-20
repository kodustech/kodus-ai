/**
 * The finder eval runs production's route and scores one finding per known bug.
 * Routing: as a cloud org, a stored BYOK config for every model (no stored
 * config only for `kodus-managed`, an org with no model of its own),
 * the platform's own OpenAI key left to the embedder, and no run at all for a
 * model production cannot reach. Scoring:
 * each known bug keeps the one finding the judge is surest of, so a repeated
 * finding is a false positive, not a second hit.
 */
const verdicts = new Map<string, { match: boolean; confidence: number }>();
jest.mock('./recall-judge', () => ({
    loadJudgeKey: () => 'key',
    matchCommentDetailed: async (_key: string, golden: string, candidate: string) =>
        verdicts.get(`${golden}|${candidate.split(' — ')[0]}`) || { match: false, confidence: 0 },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const recallAssertion = require('./recall-assertion');

const finding = (summary: string) => ({ relevantFile: 'src/a.ts', oneSentenceSummary: summary, suggestionContent: summary });
const score = async (goldens: string[], summaries: string[]) =>
    (await recallAssertion(JSON.stringify({ findings: summaries.map(finding), trace: {} }), { vars: { goldenComments: goldens } })).metadata;

describe('finder recall scoring', () => {
    beforeEach(() => verdicts.clear());

    it('credits a known bug once: a second finding of it is a false positive', async () => {
        verdicts.set('race on cache|f1', { match: true, confidence: 0.9 });
        verdicts.set('race on cache|f2', { match: true, confidence: 0.7 });
        const m = await score(['race on cache', 'missing auth'], ['f1', 'f2', 'f3']);
        expect([m.matched, m.tpFindings, m.fpFindings]).toEqual([1, 1, 2]);
        expect(m.precision).toBeCloseTo(1 / 3);
        expect(m.recall).toBe(0.5);
    });

    it('keeps the finding the judge is surest of, and counts a finding matching two bugs twice', async () => {
        verdicts.set('race on cache|f1', { match: true, confidence: 0.6 });
        verdicts.set('race on cache|f2', { match: true, confidence: 0.95 });
        verdicts.set('missing auth|f2', { match: true, confidence: 0.8 });
        const m = await score(['race on cache', 'missing auth'], ['f1', 'f2']);
        expect([m.matched, m.tpFindings, m.fpFindings]).toEqual([2, 1, 1]);
        expect(m.precision).toBeCloseTo(2 / 3);
        expect(m.goldenResults.map((g: { found: boolean }) => g.found)).toEqual([true, true]);
    });

    it('has no precision to give when nothing was found', async () => {
        const m = await score(['race on cache'], []);
        expect([m.matched, m.precision, m.recall]).toEqual([0, 0, 0]);
    });
});

describe('finder model route', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { internals } = require('./agent-provider');

    // Every model on the BYOK route, the trial's DeepSeek too: the two routes send
    // different requests for it (model-route.js), and the evals measure one.
    it("stores the trial's model as the org's BYOK config too, with the platform's keys and no self-hosted env model", () => {
        process.env.BYOK_FIREWORKS_API_KEY = 'fw';
        process.env.BYOK_OPENAI_API_KEY = 'platform-openai';
        process.env.API_LLM_PROVIDER_MODEL = 'some-self-hosted-model';
        delete process.env.API_FIREWORKS_API_KEY;
        delete process.env.FIREWORKS_API_KEY;
        delete process.env.API_OPEN_AI_API_KEY;
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_MODEL;
        const route = internals.resolveRoute({ provider: 'tier0', model: 'deepseek-v4-flash@fireworks' });
        expect(route).toMatchObject({ route: 'byok', reasoningEffort: null });
        expect(route.storedConfig.models).toEqual([expect.objectContaining({ model: 'accounts/fireworks/models/deepseek-v4p1-flash' })]);
        expect(process.env.API_FIREWORKS_API_KEY).toBe('fw');
        expect(process.env.API_OPEN_AI_API_KEY).toBe('platform-openai');
        expect(process.env.API_LLM_PROVIDER_MODEL).toBeUndefined();
    });

    // The managed route's contract test (wiring smoke `managed-route`): an org with no model config.
    it('routes kodus-managed with no stored config, as an org with no model of its own', () => {
        process.env.BYOK_FIREWORKS_API_KEY = 'fw';
        delete process.env.RECALL_MODEL;
        delete process.env.RECALL_REASONING_EFFORT;
        expect(internals.resolveRoute({ provider: 'tier0', model: 'kodus-managed' })).toMatchObject({ storedConfig: null, route: 'managed', reasoningEffort: null });
        process.env.RECALL_REASONING_EFFORT = 'high';
        try {
            expect(() => internals.resolveRoute({ provider: 'tier0', model: 'kodus-managed' })).toThrow(/no reasoning effort/);
        } finally {
            delete process.env.RECALL_REASONING_EFFORT;
        }
    });

    it("stores any other model as the org's BYOK config, and never puts its key where the embedder reads", () => {
        process.env.EVAL_FAKE_LLM_URL = 'http://127.0.0.1:1/v1';
        process.env.EVAL_FAKE_LLM_KEY = 'fake';
        delete process.env.API_OPEN_AI_API_KEY;
        delete process.env.BYOK_OPENAI_API_KEY;
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_MODEL;
        const route = internals.resolveRoute({ provider: 'tier0', model: 'eval-fake' });
        expect(route).toMatchObject({ route: 'byok', modelId: 'eval-fake', reasoningEffort: null });
        expect(route.storedConfig.models).toEqual([{ id: 'eval-model', credentialId: 'eval-credential', model: 'eval-fake' }]);
        expect(process.env.API_OPEN_AI_API_KEY).toBeUndefined();
    });

    it('stores a BYOK config carrying the asked effort, routed to the codeReview task', () => {
        process.env.EVAL_FAKE_LLM_URL = 'http://127.0.0.1:1/v1';
        process.env.EVAL_FAKE_LLM_KEY = 'fake';
        process.env.RECALL_REASONING_EFFORT = 'low';
        delete process.env.RECALL_MODEL;
        const route = internals.resolveRoute({ provider: 'tier0', model: 'eval-fake' });
        expect(route).toMatchObject({ route: 'byok', reasoningEffort: 'low' });
        expect(route.storedConfig).toMatchObject({
            version: 2,
            credentials: [{ provider: 'openai_compatible', settings: { baseURL: 'http://127.0.0.1:1/v1' } }],
            models: [{ model: 'eval-fake', reasoningEffort: 'low' }],
            routing: { defaultModelId: 'eval-model' },
        });
        expect(route.storedConfig.credentials[0].apiKey).not.toBe('fake');
    });

    it('takes the model from RECALL_MODEL over the config, on either route', () => {
        process.env.EVAL_FAKE_LLM_URL = 'http://127.0.0.1:1/v1';
        process.env.EVAL_FAKE_LLM_KEY = 'fake';
        process.env.RECALL_MODEL = 'eval-fake';
        delete process.env.RECALL_REASONING_EFFORT;
        expect(internals.resolveRoute({ provider: 'tier0', model: 'gpt-5.6-luna@sub' })).toMatchObject({ route: 'byok', modelId: 'eval-fake' });
        process.env.RECALL_REASONING_EFFORT = 'low';
        expect(internals.resolveRoute({ provider: 'tier0', model: 'gpt-5.6-luna@sub' }).storedConfig).toMatchObject({ models: [{ model: 'eval-fake' }] });
        process.env.RECALL_MODEL = 'gpt-5.6-luna@sub';
        expect(() => internals.resolveRoute({ provider: 'tier0', model: 'eval-fake' })).toThrow(internals.NotAProductionRoute);
    });

    it('refuses a subscription model instead of running another one', () => {
        delete process.env.RECALL_MODEL;
        expect(() => internals.resolveRoute({ provider: 'tier0', model: 'gpt-5.6-luna@sub' })).toThrow(internals.NotAProductionRoute);
    });
});

describe('finder input data', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { internals } = require('./agent-provider');

    it("hands over the case's memories as a member writes them, and its overrides as the team's config", () => {
        delete process.env.RECALL_CATEGORIES;
        delete process.env.RECALL_HEAVY;
        const team = internals.teamOf({ languageResultPrompt: 'pt-BR', memoryRules: [{ title: 't', rule: 'r', type: 'memory' }], v2PromptOverrides: { generation: { main: 'x' } } });
        expect(team.language).toBe('pt-BR');
        expect(team.memories).toEqual([{ title: 't', rule: 'r', path: null }]);
        expect(team.codeReviewConfig.configs.v2PromptOverrides).toEqual({ generation: { main: 'x' } });
        expect(internals.teamOf({}).codeReviewConfig).toBeNull();
    });

    it("stores a memory through production's write, and the review reads it back as an active global memory", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { teamStore } = require('../shared/review-stage');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { evalPermissionService, EVAL_ORG } = require('../shared/model-route');
        const store = await teamStore({ memories: [{ title: 't', rule: 'r' }, { title: 'u', rule: 's' }] }, evalPermissionService(null));
        const entity = await store.kodyRulesService.findByOrganizationId(EVAL_ORG.organizationId);
        expect(entity.toObject().rules).toMatchObject([
            { title: 't', rule: 'r', type: 'memory', status: 'active', repositoryId: 'global', origin: 'manual' },
            { title: 'u', rule: 's', type: 'memory', status: 'active', repositoryId: 'global', origin: 'manual' },
        ]);
    });

    it("saves a run's --team-config over the case's own keys, as a team saving them would", () => {
        delete process.env.RECALL_CATEGORIES;
        delete process.env.RECALL_HEAVY;
        const team = internals.teamOf({ reviewMode: 'light', v2PromptOverrides: { generation: { main: 'x' } } }, { reviewMode: 'heavy', newKey: true });
        expect(team.codeReviewConfig.configs).toEqual({ v2PromptOverrides: { generation: { main: 'x' } }, reviewMode: 'heavy', newKey: true });
        expect(internals.teamOf({}, { newKey: true }).codeReviewConfig.configs).toEqual({ newKey: true });
    });

    it('refuses a mode production gates behind a release the eval has no org for', () => {
        process.env.RECALL_HEAVY = '1';
        expect(() => internals.teamOf({})).toThrow(internals.NotAProductionRoute);
    });

    it("needs the platform's recorded files for a case, and hands them over as they are", () => {
        expect(() => internals.prOf({ caseId: 'c' })).toThrow(/fetch-pr-data/);
        const files = [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x', status: 'modified' }];
        const pr = internals.prOf({ caseId: 'c', repositoryFullName: 'o/r', prNumber: 3, prHead: { ref: 'h', sha: 's' }, prBase: { ref: 'main' }, prFiles: files });
        expect(pr).toMatchObject({ repo: 'o/r', number: 3, headRef: 'h', headSha: 's', baseRef: 'main', files });
    });

    it('computes the files of a repository written for the eval as the platform lists them', () => {
        const pr = internals.prOf({ caseId: 'c', repoBase: { 'a.ts': 'x\n', 'gone.ts': 'y\n', 'same.ts': 'z\n' }, repoFiles: { 'a.ts': 'x2\n', 'new.ts': 'n\n', 'gone.ts': null } });
        expect(pr.repo).toBeUndefined();
        expect(pr.files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
            ['a.ts', 'modified', 1, 1],
            ['gone.ts', 'removed', 0, 1],
            ['new.ts', 'added', 1, 0],
        ]);
        expect(pr.files[0].patch).toBe('@@ -1,1 +1,1 @@\n-x\n+x2');
    });

    it('sets the team category toggles only when RECALL_CATEGORIES asks', () => {
        delete process.env.RECALL_CATEGORIES;
        expect(internals.reviewOptionsFromEnv()).toBeUndefined();
        process.env.RECALL_CATEGORIES = 'bug, security';
        expect(internals.reviewOptionsFromEnv()).toEqual({ bug: true, security: true, performance: false });
    });

    it("reports one batch's loop as is, and several in order with counts summed", () => {
        const one = { findings: { reasoning: 'r', suggestions: [{ a: 1 }] }, steps: 3, usage: { inputTokens: 5 } };
        expect(internals.combineLoops([{ result: one }])).toBe(one);
        const two = { findings: { reasoning: 's', suggestions: [{ b: 2 }] }, steps: 4, usage: { inputTokens: 6 } };
        expect(internals.combineLoops([{ result: one }, { result: two }])).toMatchObject({
            findings: { reasoning: 'r\n\ns', suggestions: [{ a: 1 }, { b: 2 }] },
            steps: 7,
            usage: { inputTokens: 11 },
        });
    });
});

describe('the observed review (funnel snapshot)', () => {
    it('ships what the same review ships unobserved, and records every step after the agents', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spawnSync } = require('child_process');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');
        const r = spawnSync(process.execPath, [path.join(__dirname, '../funnel/observe-check.js')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
        expect({ status: r.status, out: r.stdout.split('\n').filter((l: string) => l.startsWith('{"shipped')).pop() }).toMatchObject({ status: 0 });
    }, 120_000);
});

describe('finder control cases and sets', () => {
    it('scores a case with no known bug as a control: every finding shipped is noise', async () => {
        const quiet = await recallAssertion(JSON.stringify({ findings: [], trace: {} }), { vars: { goldenComments: [] } });
        expect(quiet).toMatchObject({ pass: true, metadata: { control: true, recall: null, goldens: 0, fpFindings: 0 } });
        const noisy = await recallAssertion(JSON.stringify({ findings: [finding('f1'), finding('f2')], trace: {} }), { vars: { goldenComments: [] } });
        expect(noisy).toMatchObject({ pass: false, metadata: { control: true, fpFindings: 2, findings: 2 } });
    });

    it('reads a control as a case with no recall and its findings as noise, and every case with its unmatched findings', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { finderCases } = require('../stage-signals');
        const [control, pr] = finderCases([
            { caseId: 'c', metadata: { control: true, goldens: 0, matched: 0, fpFindings: 3, goldenResults: [] } },
            { caseId: 'p', metadata: { goldens: 2, matched: 1, fpFindings: 4, goldenResults: [{ golden: 'a', found: true }, { golden: 'b', found: false }] } },
        ]);
        expect(control).toMatchObject({ id: 'c', hits: 0, total: 0, control: true, fpFindings: 3, checks: expect.stringContaining('control: nothing to find') });
        expect(pr).toMatchObject({ id: 'p', hits: 1, total: 2, fpFindings: 4 });
    });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setFiles, namedSets } = require('./recall-tests');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsx = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const px = require('path');

    it('takes every dataset of a set of its own, or of a private folder, and refuses an unknown name', () => {
        const dir = fsx.mkdtempSync(px.join(os.tmpdir(), 'sets-'));
        try {
            fsx.mkdirSync(px.join(dir, 'deps'));
            fsx.writeFileSync(px.join(dir, 'deps', 'a.json'), '{}');
            fsx.mkdirSync(px.join(dir, 'empty'));
            expect(namedSets(dir)).toEqual(['deps']);
            expect(setFiles('deps', dir)).toEqual({ files: [px.join(dir, 'deps', 'a.json')], ids: null });
            expect(setFiles(px.join(dir, 'deps'), dir)).toEqual({ files: [px.join(dir, 'deps', 'a.json')], ids: null });
            expect(setFiles('controlled', dir).ids).toHaveLength(15);
            expect(() => setFiles('empty', dir)).toThrow(/unknown set 'empty'/);
            expect(() => setFiles('contolled', dir)).toThrow(/unknown set 'contolled'/);
        } finally {
            fsx.rmSync(dir, { recursive: true, force: true });
        }
    });
});
