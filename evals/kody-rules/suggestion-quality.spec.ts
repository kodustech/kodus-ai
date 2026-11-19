const {
    judgeInputs,
    scoreVerdict,
    emptyQuality,
    addQuality,
    judgeRoute,
    snapshotTokens,
    restoreTokens,
} = require('./suggestion-quality');

const rule = {
    uuid: 'r1',
    title: 'No console.log',
    rule: 'Do not leave console.log in committed code; use the logger.',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.info(x)' },
    ],
};

const suggestion = {
    relevantFile: 'src/a.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 3,
    suggestionContent: 'console.log left in the handler; use the logger.',
    oneSentenceSummary: 'console.log left in the request handler',
    existingCode: 'console.log(req.body);',
    improvedCode: 'logger.info(req.body);',
};

const fileContent = [
    'import x;',
    'function h(req) {',
    '  console.log(req.body);',
    '}',
].join('\n');

describe('judgeInputs — a Kody Rules finding as the fix/title judge reads it', () => {
    it('states the rule as the defect and its obligations', () => {
        const { ref } = judgeInputs(suggestion, rule, fileContent);
        expect(ref.defectStatement).toContain('No console.log');
        expect(ref.defectStatement).toContain('use the logger');
        expect(ref.obligations.length).toBeGreaterThan(0);
        expect(ref.exampleFix).toBe('logger.info(x)');
    });

    it('carries the finding, the cited code and a window of the file', () => {
        const { item } = judgeInputs(suggestion, rule, fileContent);
        expect(item.finding).toMatchObject({
            relevantFile: 'src/a.ts',
            relevantLinesStart: 3,
            relevantLinesEnd: 3,
            suggestionContent: suggestion.suggestionContent,
        });
        expect(item.deterministic.existingCode).toBe('console.log(req.body);');
        expect(item.context.window).toContain('3: ');
        expect(item.context.window).toContain('console.log(req.body);');
    });

    it('answers with the title and the fix the agent wrote', () => {
        const { ans } = judgeInputs(suggestion, rule, fileContent);
        expect(ans).toEqual({
            oneSentenceSummary: 'console.log left in the request handler',
            fixStatus: 'local',
            improvedCode: 'logger.info(req.body);',
        });
    });

    it('marks a finding without improvedCode as having no fix', () => {
        const { ans, ref } = judgeInputs(
            { ...suggestion, improvedCode: null },
            rule,
            fileContent,
        );
        expect(ans.fixStatus).toBe('none');
        expect(ref.fixability).toBe('none');
    });

    it('survives a file it could not read', () => {
        const { item } = judgeInputs(suggestion, rule, undefined);
        expect(item.context.window).toBeUndefined();
    });
});

describe('scoreVerdict', () => {
    const verdict = (fix: string, titleNamesProblem = true) => ({
        fix,
        titleNamesProblem,
        fixReason: '',
        titleReason: '',
    });

    it('scores a good title and a passing fix', () => {
        expect(scoreVerdict(suggestion, verdict('PASS'))).toEqual({
            titleOk: true,
            fixGraded: true,
            fixPass: true,
        });
    });

    it('fails a well-formed title the judge says does not name the problem', () => {
        expect(scoreVerdict(suggestion, verdict('PASS', false)).titleOk).toBe(false);
    });

    it('needs the title format too, not only the judge', () => {
        const long = {
            ...suggestion,
            oneSentenceSummary: `${'x'.repeat(90)}.`,
        };
        expect(scoreVerdict(long, verdict('PASS')).titleOk).toBe(false);
    });

    it('does not grade a fix the judge could not assess', () => {
        expect(scoreVerdict(suggestion, verdict('UNASSESSABLE'))).toMatchObject(
            {
                fixGraded: false,
                fixPass: false,
            },
        );
    });

    it('counts a missing fix as a graded fail', () => {
        expect(
            scoreVerdict(
                { ...suggestion, improvedCode: null },
                verdict('NOT_APPLICABLE'),
            ),
        ).toMatchObject({
            fixGraded: true,
            fixPass: false,
        });
    });
});

describe('quality tallies', () => {
    it('adds scored findings', () => {
        const q = emptyQuality();
        addQuality(q, { titleOk: true, fixGraded: true, fixPass: true });
        addQuality(q, { titleOk: false, fixGraded: true, fixPass: false });
        addQuality(q, { titleOk: true, fixGraded: false, fixPass: false });
        expect(q).toEqual({
            graded: 3,
            titleOk: 2,
            fixGraded: 2,
            fixPass: 1,
            judgeErrors: 0,
        });
    });
});

describe('judgeRoute — the judge runs as itself, whatever the reviewed model is set to', () => {
    const OLD_ENV = process.env;
    beforeEach(() => {
        process.env = {
            ...OLD_ENV,
            RECALL_MODEL: 'claude-sonnet-5-5',
            RECALL_REASONING_EFFORT: 'high',
            EVAL_FAKE_LLM_URL: 'http://127.0.0.1:9/v1',
            EVAL_FAKE_LLM_KEY: 'fake',
        };
    });
    afterAll(() => {
        process.env = OLD_ENV;
    });

    it('ignores the reviewed model and its reasoning effort, and leaves both set for the review', () => {
        const route = judgeRoute('eval-fake');
        expect(route).toMatchObject({
            modelId: 'eval-fake',
            reasoningEffort: null,
        });
        expect(process.env.RECALL_MODEL).toBe('claude-sonnet-5-5');
        expect(process.env.RECALL_REASONING_EFFORT).toBe('high');
    });
});

describe('snapshotTokens / restoreTokens — the judge is not the review', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tokensUsed } = require('../shared/eval-kit');

    it('takes back every call, time and reasoning effort the judge added', () => {
        const t = tokensUsed();
        Object.assign(t, { in: 10, out: 2, cacheRead: 0, cacheWrite: 0, calls: 1, ms: 50 });
        t.callMs.splice(0, t.callMs.length, 50);
        t.efforts = { codeReview: ['high'] };
        const before = snapshotTokens();

        t.in += 7;
        t.calls += 1;
        t.callMs.push(30);
        t.efforts.codeReview.push('low');
        t.efforts.judge = ['none'];
        restoreTokens(before);

        expect(t).toMatchObject({ in: 10, calls: 1, ms: 50, callMs: [50] });
        expect(t.efforts).toEqual({ codeReview: ['high'] });
    });
});
