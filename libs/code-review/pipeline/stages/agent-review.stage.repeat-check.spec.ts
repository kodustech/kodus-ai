import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { LLM } from '@libs/llm/llm';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * #2097 — the repeat check inside AgentReviewStage: it reads the PR's whole
 * history (not only the prompts' 40 most recent) and keeps a repeat out of
 * the review as `discarded-by-repeat`, whatever the earlier comment's status.
 * `repeat-check.spec.ts` covers the decision itself.
 */

const earlier = (over: Partial<PrDecisionRecord>): PrDecisionRecord => ({
    suggestionId: 'old',
    relevantFile: 'src/user.ts',
    relevantLinesStart: 10,
    relevantLinesEnd: 10,
    suggestionContent: 'Earlier comment.',
    label: 'bug',
    outcome: 'pending',
    decidedAt: '2026-10-01T10:00:00Z',
    ...over,
});

const ruleComment = earlier({
    suggestionId: 'old-rule',
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-logger'],
    existingCode: "console.log('user', user)",
    suggestionContent: 'Use the logger instead of console.log.',
});

const ruleFinding = {
    relevantFile: 'src/user.ts',
    relevantLinesStart: 14,
    relevantLinesEnd: 14,
    label: 'kody_rules',
    brokenKodyRulesIds: ['rule-logger'],
    severity: 'high',
    oneSentenceSummary: 'console.log instead of the logger',
    suggestionContent: 'Use the logger instead of console.log.',
    existingCode: "console.log('user',  user)",
    improvedCode: "logger.info({ user }, 'user')",
};

const bugFinding = {
    relevantFile: 'src/user.ts',
    relevantLinesStart: 20,
    relevantLinesEnd: 22,
    label: 'bug',
    severity: 'high',
    oneSentenceSummary: 'user can be null and is dereferenced',
    suggestionContent: 'user can be null and is dereferenced here',
    existingCode: 'const name = user.name;',
    improvedCode: 'const name = user?.name;',
};

const envelope = (suggestions: any[]) => ({
    suggestions,
    agentResults: [],
    failures: [],
    incomplete: [],
    warnings: [],
});

const makeStage = (wholeHistory: PrDecisionRecord[]) => {
    const reviewOrchestrator = { execute: jest.fn() };
    const historyUseCase = {
        execute: jest.fn().mockResolvedValue(wholeHistory),
    };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        reviewOrchestrator as any,
        { runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()) } as any,
        {
            generateContext: jest.fn(),
            generateContextLegacy: jest.fn(),
        } as any,
        { isEnabled: jest.fn().mockResolvedValue(false) } as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        {
            getRepositories: jest.fn().mockResolvedValue([]),
            getCloneParams: jest.fn().mockResolvedValue(null),
        } as any,
        undefined,
        undefined,
        historyUseCase as any,
    );
    return { stage, reviewOrchestrator, historyUseCase };
};

const makeContext = (
    previousDecisions: PrDecisionRecord[],
    changedFiles: any[] = [{ filename: 'src/user.ts' }],
) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1', fullName: 'acme/repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles,
        codeReviewConfig: {
            reviewOptions: {},
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            kodyRules: [
                {
                    uuid: 'rule-logger',
                    title: 'Use the logger',
                    rule: 'Log through the logger, never console.log.',
                    severity: 'high',
                },
            ],
        },
        previousDecisions,
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
    }) as any as CodeReviewPipelineContext;

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

const published = (result: any) =>
    (result.fileAnalysisResults ?? []).flatMap(
        (f: any) => f.validSuggestionsToAnalyze ?? [],
    );

let runSpy: jest.SpyInstance;
let repeatAnswer: unknown;
beforeEach(() => {
    repeatAnswer = { verdicts: [] };
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockImplementation((async (req: any) =>
            req.spanName === 'code-review::repeat-check'
                ? repeatAnswer
                : { groups: [], unique: [0, 1, 2, 3] }) as any);
});
afterEach(() => {
    runSpy.mockRestore();
    jest.clearAllMocks();
});

describe('AgentReviewStage — repeat check (#2097)', () => {
    it("reads the whole history and keeps a rule repeat older than the prompts' history out of the review", async () => {
        const recent = Array.from({ length: 3 }, (_, i) =>
            earlier({
                suggestionId: `recent-${i}`,
                relevantFile: 'src/other.ts',
            }),
        );
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([
            ...recent,
            ruleComment,
        ]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext(recent));

        expect(historyUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 7,
                repositoryFullName: 'acme/repo-1',
                limit: 500,
            }),
        );
        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions).toEqual([
            expect.objectContaining({
                existingCode: ruleFinding.existingCode,
                priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
                deliveryStatus: 'not_sent',
            }),
        ]);
    });

    // Review of #2137: the check ran after the per-rule merge, which folds
    // every finding of a rule into the one with the longest text, so the
    // whole group was kept or dropped by that one. Each occurrence is judged
    // on its own now, whichever text is longer.
    it.each([
        ['the repeated occurrence has the longer text', 'x'.repeat(400), ''],
        ['the new occurrence has the longer text', '', 'x'.repeat(400)],
    ])(
        'posts the new occurrence of a rule and keeps the repeated one off when %s',
        async (_name, oldPad, newPad) => {
            const { stage, reviewOrchestrator } = makeStage([ruleComment]);
            const repeated = {
                ...ruleFinding,
                suggestionContent: `${ruleFinding.suggestionContent}${oldPad}`,
            };
            const fresh = {
                ...ruleFinding,
                relevantLinesStart: 40,
                relevantLinesEnd: 40,
                existingCode: "console.log('order', order)",
                suggestionContent: `This logs the whole order.${newPad}`,
            };
            reviewOrchestrator.execute.mockResolvedValue(
                envelope([repeated, fresh]),
            );

            const result = await run(stage, makeContext([ruleComment]));

            const posted = published(result);
            expect(posted.map((s: any) => s.relevantLinesStart)).toEqual([40]);
            expect(posted[0].suggestionContent).not.toContain('Also found in');
            expect(
                result.discardedSuggestions.map(
                    (s: any) => `${s.relevantLinesStart}:${s.priorityStatus}`,
                ),
            ).toEqual([`14:${PriorityStatus.DISCARDED_BY_REPEAT}`]);
        },
    );

    it('keeps a bug still there after its comment was applied out of the review', async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            existingCode: 'const name = user.name;',
            suggestionContent: 'user can be null here.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([bugFinding]));
        repeatAnswer = {
            verdicts: [
                {
                    finding: 0,
                    verdict: 'same_occurrence',
                    earlierId: 'old-bug',
                },
            ],
        };

        const result = await run(stage, makeContext([applied]));

        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions).toEqual([
            expect.objectContaining({
                existingCode: bugFinding.existingCode,
                priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
            }),
        ]);
    });

    it("matches a finder finding to an earlier comment on the same code in another file, by its cited lines", async () => {
        const moved = earlier({
            suggestionId: 'old-moved',
            relevantFile: 'src/user.ts',
            existingCode: 'const total = items.reduce((a, b) => a + b.price);',
            suggestionContent: 'The reduce has no initial value.',
        });
        const { stage, reviewOrchestrator } = makeStage([moved]);
        // The finder's lean finding: lines and text, no code.
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([
                {
                    relevantFile: 'src/cart.ts',
                    relevantLinesStart: 2,
                    relevantLinesEnd: 2,
                    label: 'bug',
                    suggestionContent: 'Empty carts throw a TypeError.',
                },
            ]),
        );
        const ctx = makeContext(
            [moved],
            [
                {
                    filename: 'src/cart.ts',
                    fileContent:
                        'export function total(items) {\nconst total = items.reduce((a, b) => a + b.price);\nreturn total;\n}\n',
                },
            ],
        );

        await run(stage, ctx);

        const repeatCall = runSpy.mock.calls.find(
            ([req]: any) => req.spanName === 'code-review::repeat-check',
        );
        expect(repeatCall).toBeDefined();
        expect(JSON.stringify(repeatCall![0])).toContain('old-moved');
    });

    it("logs a finding on a file the PR does not change with the review's ids", async () => {
        const { stage, reviewOrchestrator } = makeStage([]);
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([{ ...bugFinding, relevantFile: 'src/other.ts' }]),
        );
        const logSpy = jest.spyOn((stage as any).logger, 'log');

        await run(stage, makeContext([]));

        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('the file is not changed by this PR'),
                metadata: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    prNumber: 7,
                    relevantFile: 'src/other.ts',
                },
            }),
        );
    });

    it('reads the cited code from the diff when the review has no file content (CLI)', async () => {
        const moved = earlier({
            suggestionId: 'old-moved',
            relevantFile: 'src/user.ts',
            existingCode: 'const total = items.reduce((a, b) => a + b.price);',
            suggestionContent: 'The reduce has no initial value.',
        });
        const { stage, reviewOrchestrator } = makeStage([moved]);
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([
                {
                    relevantFile: 'src/cart.ts',
                    relevantLinesStart: 2,
                    relevantLinesEnd: 2,
                    label: 'bug',
                    suggestionContent: 'Empty carts throw a TypeError.',
                },
            ]),
        );
        const ctx = makeContext(
            [moved],
            [
                {
                    filename: 'src/cart.ts',
                    patch: '@@ -1,2 +1,3 @@\n export function total(items) {\n+const total = items.reduce((a, b) => a + b.price);\n }',
                },
            ],
        );

        await run(stage, ctx);

        const repeatCall = runSpy.mock.calls.find(
            ([req]: any) => req.spanName === 'code-review::repeat-check',
        );
        expect(JSON.stringify(repeatCall?.[0])).toContain('old-moved');
    });

    it('posts a bug the check does not match, with the revision link its finder chose', async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            suggestionContent: 'Return early when user is missing.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(
            envelope([{ ...bugFinding, revisesSuggestionId: 'old-bug' }]),
        );

        const result = await run(stage, makeContext([applied]));

        const [comment] = published(result);
        expect(comment.suggestionContent).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\* on `src\/user\.ts:10`/,
        );
    });

    it('links a kept finding when the repeat check identifies the earlier suggestion', async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            suggestionContent: 'Return early when user is missing.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([bugFinding]));
        repeatAnswer = {
            verdicts: [
                {
                    finding: 0,
                    verdict: 'caused_by_earlier',
                    earlierId: 'old-bug',
                },
            ],
        };

        const result = await run(stage, makeContext([applied]));

        const [comment] = published(result);
        expect(comment.revisesSuggestionId).toBe('old-bug');
        expect(comment.suggestionContent).toMatch(
            /^\*\*Revises an earlier Kody suggestion\*\* on `src\/user\.ts:10`/,
        );
    });

    it("links a lean finder finding, whose cited code the check read on a copy", async () => {
        const applied = earlier({
            suggestionId: 'old-bug',
            outcome: 'implemented',
            suggestionContent: 'Return early when user is missing.',
        });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        const { existingCode, improvedCode, oneSentenceSummary, ...lean } =
            bugFinding;
        reviewOrchestrator.execute.mockResolvedValue(envelope([lean]));
        repeatAnswer = {
            verdicts: [
                {
                    finding: 0,
                    verdict: 'caused_by_earlier',
                    earlierId: 'old-bug',
                },
            ],
        };
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        lines[19] = 'const name = user.name;';

        const result = await run(
            stage,
            makeContext(
                [applied],
                [{ filename: 'src/user.ts', fileContent: lines.join('\n') }],
            ),
        );

        const [comment] = published(result);
        expect(comment.revisesSuggestionId).toBe('old-bug');
    });

    it('leaves an unrelated finding unlinked', async () => {
        const applied = earlier({ suggestionId: 'old-bug' });
        const { stage, reviewOrchestrator } = makeStage([applied]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([bugFinding]));
        repeatAnswer = {
            verdicts: [
                { finding: 0, verdict: 'different_problem', earlierId: null },
            ],
        };

        const result = await run(stage, makeContext([applied]));

        const [comment] = published(result);
        expect(comment.revisesSuggestionId).toBeUndefined();
        expect(comment.suggestionContent).not.toContain(
            'Revises an earlier Kody suggestion',
        );
    });

    it('a PR without history is not checked', async () => {
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([
            ruleComment,
        ]);
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext([]));

        expect(historyUseCase.execute).not.toHaveBeenCalled();
        expect(published(result)).toHaveLength(1);
    });

    it("falls back to the prompts' history when the whole history cannot be read", async () => {
        const { stage, reviewOrchestrator, historyUseCase } = makeStage([]);
        historyUseCase.execute.mockRejectedValue(new Error('Mongo down'));
        reviewOrchestrator.execute.mockResolvedValue(envelope([ruleFinding]));

        const result = await run(stage, makeContext([ruleComment]));

        expect(published(result)).toEqual([]);
        expect(result.discardedSuggestions[0].priorityStatus).toBe(
            PriorityStatus.DISCARDED_BY_REPEAT,
        );
    });
});
