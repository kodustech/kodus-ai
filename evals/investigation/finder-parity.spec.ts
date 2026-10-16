/**
 * The finder eval runs production's route and scores one finding per known bug.
 * Routing: the env/managed route by default, a stored BYOK config when an effort
 * is asked for, and no run at all for a model production cannot reach. Scoring:
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

    it('runs the env/managed route with no stored config by default', () => {
        process.env.EVAL_FAKE_LLM_URL = 'http://127.0.0.1:1/v1';
        process.env.EVAL_FAKE_LLM_KEY = 'fake';
        delete process.env.RECALL_REASONING_EFFORT;
        delete process.env.RECALL_MODEL;
        expect(internals.resolveRoute({ provider: 'tier0', model: 'eval-fake' })).toMatchObject({ storedConfig: null, route: 'managed', modelId: 'eval-fake' });
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

    it('refuses a subscription model instead of running another one', () => {
        delete process.env.RECALL_MODEL;
        expect(() => internals.resolveRoute({ provider: 'tier0', model: 'gpt-5.6-luna@sub' })).toThrow(internals.NotAProductionRoute);
    });
});
