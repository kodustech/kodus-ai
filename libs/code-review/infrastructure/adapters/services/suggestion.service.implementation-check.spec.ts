import { SuggestionService } from './suggestion.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';

const org = { organizationId: 'org-1', teamId: 'team-1' };

const sent = (id: string, relevantFile = 'app/a.rb', extra = {}) => ({
    id,
    relevantFile,
    deliveryStatus: DeliveryStatus.SENT,
    implementationStatus: ImplementationStatus.NOT_IMPLEMENTED,
    ...extra,
});

const decidedRecord = (verdict: ImplementationStatus) => ({
    checkedAt: expect.any(String),
    outcome: 'decided',
    verdict,
});

const unmeasuredRecord = (reason: string) => ({
    checkedAt: expect.any(String),
    outcome: 'unmeasured',
    reason,
});

describe('SuggestionService.checkImplementedSuggestions', () => {
    let aiAnalysisService: { checkSuggestionImplementation: jest.Mock };
    let pullRequestService: { updateSuggestion: jest.Mock };
    let permissionValidationService: { resolveTaskSlot: jest.Mock };
    let service: SuggestionService;

    // The model answers every suggestion it is asked about with `status`.
    const answerAll = (status: ImplementationStatus) =>
        aiAnalysisService.checkSuggestionImplementation.mockImplementation(
            async ({ suggestions }) => ({
                verdicts: suggestions.map((s) => ({ id: s.id, status })),
                unmeasured: [],
            }),
        );

    beforeEach(() => {
        aiAnalysisService = {
            checkSuggestionImplementation: jest
                .fn()
                .mockResolvedValue({ verdicts: [], unmeasured: [] }),
        };
        pullRequestService = {
            updateSuggestion: jest.fn().mockResolvedValue({}),
        };
        permissionValidationService = {
            resolveTaskSlot: jest
                .fn()
                .mockResolvedValue({ provider: 'openai', model: 'gpt-x' }),
        };
        service = new SuggestionService(
            aiAnalysisService as any,
            pullRequestService as any,
            {} as any,
            {} as any,
            {} as any,
            permissionValidationService as any,
        );
    });

    const check = (
        savedSuggestions: unknown[],
        changedFiles: unknown[],
        diffSource?: string,
    ) =>
        service.checkImplementedSuggestions({
            organizationAndTeamData: org,
            prNumber: 42,
            changedFiles: changedFiles as any,
            savedSuggestions: savedSuggestions as any,
            ...(diffSource ? { diffSource: diffSource as any } : {}),
        });

    const writesFor = (id: string) =>
        pullRequestService.updateSuggestion.mock.calls.filter(
            ([written]) => written === id,
        );

    it('skips with NO_SUGGESTIONS when nothing sent is left to check', async () => {
        const result = await check(
            [
                sent('done', 'app/a.rb', {
                    implementationStatus: ImplementationStatus.IMPLEMENTED,
                }),
                sent('unsent', 'app/a.rb', {
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(result).toEqual({
            skipped: 'NO_SUGGESTIONS',
            checked: 0,
            persisted: [],
            decided: 0,
            unmeasured: [],
        });
        expect(
            aiAnalysisService.checkSuggestionImplementation,
        ).not.toHaveBeenCalled();
    });

    it('skips with NO_RELEVANT_CHANGES when no suggested file changed', async () => {
        const result = await check(
            [sent('s-1', 'app/a.rb')],
            [{ filename: 'app/other.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(result).toEqual({
            skipped: 'NO_RELEVANT_CHANGES',
            checked: 1,
            persisted: [],
            decided: 0,
            unmeasured: [],
        });
    });

    it('asks once per changed file, with that file patch and what each of its suggestions asked', async () => {
        await check(
            [
                sent('s-index', 'src/index.ts', {
                    suggestionContent: 'Use || instead of &&.',
                    fullExplanation: 'The long reasoning behind it.',
                    existingCode: 'a && b',
                    improvedCode: 'a || b',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 4,
                    comment: { id: 1 },
                }),
                sent('s-utils', 'src/utils.ts', {
                    fullExplanation: 'Escape the url.',
                    existingCode: 'url',
                    improvedCode: '',
                }),
                sent('s-other', 'src/other.ts'),
            ],
            [
                { filename: 'src/index.ts', patch: 'patch1' },
                { filename: 'src/utils.ts', patch: 'patch2' },
                { filename: 'src/untouched-by-kody.ts', patch: 'patch3' },
            ],
        );

        const calls =
            aiAnalysisService.checkSuggestionImplementation.mock.calls.map(
                ([params]) => params,
            );
        expect(calls).toHaveLength(2);
        expect(calls).toEqual(
            expect.arrayContaining([
                {
                    organizationAndTeamData: org,
                    prNumber: 42,
                    byokConfig: { provider: 'openai', model: 'gpt-x' },
                    file: { filename: 'src/index.ts', patch: 'patch1' },
                    suggestions: [
                        {
                            id: 's-index',
                            relevantLinesStart: 3,
                            relevantLinesEnd: 4,
                            problem: 'Use || instead of &&.',
                            existingCode: 'a && b',
                            improvedCode: 'a || b',
                        },
                    ],
                },
                expect.objectContaining({
                    file: { filename: 'src/utils.ts', patch: 'patch2' },
                    suggestions: [
                        expect.objectContaining({
                            id: 's-utils',
                            problem: 'Escape the url.',
                            improvedCode: '',
                        }),
                    ],
                }),
            ]),
        );
    });

    it('raises a status with a write that cannot overwrite an equal or higher one', async () => {
        answerAll(ImplementationStatus.IMPLEMENTED);

        const result = await check(
            [
                sent('s-1', 'app/a.rb', {
                    implementationStatus:
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(pullRequestService.updateSuggestion).toHaveBeenCalledWith(
            's-1',
            {
                implementationStatus: ImplementationStatus.IMPLEMENTED,
                implementationCheck: decidedRecord(
                    ImplementationStatus.IMPLEMENTED,
                ),
                updatedAt: expect.any(String),
            },
            org,
            {
                implementationStatusNotIn: [ImplementationStatus.IMPLEMENTED],
                returnDocument: false,
            },
        );
        expect(result).toEqual({
            checked: 1,
            decided: 1,
            persisted: [
                {
                    id: 's-1',
                    implementationStatus: ImplementationStatus.IMPLEMENTED,
                },
            ],
            unmeasured: [],
        });
    });

    it('keeps a recorded partial when the new verdict is lower, recording only what the check saw', async () => {
        answerAll(ImplementationStatus.NOT_IMPLEMENTED);

        const result = await check(
            [
                sent('s-1', 'app/a.rb', {
                    implementationStatus:
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(writesFor('s-1')).toEqual([
            [
                's-1',
                {
                    implementationCheck: decidedRecord(
                        ImplementationStatus.NOT_IMPLEMENTED,
                    ),
                },
                org,
                { returnDocument: false },
            ],
        ]);
        expect(result.persisted).toEqual([]);
        expect(result.decided).toBe(1);
    });

    it('records only the check when a concurrent check already raised the status', async () => {
        answerAll(ImplementationStatus.PARTIALLY_IMPLEMENTED);
        // The conditional write matched nothing: the stored status is already
        // partial or higher.
        pullRequestService.updateSuggestion.mockResolvedValueOnce(null);

        const result = await check(
            [sent('s-1', 'app/a.rb')],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(writesFor('s-1')).toEqual([
            [
                's-1',
                expect.objectContaining({
                    implementationStatus:
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                }),
                org,
                {
                    implementationStatusNotIn: [
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                        ImplementationStatus.IMPLEMENTED,
                    ],
                    returnDocument: false,
                },
            ],
            [
                's-1',
                {
                    implementationCheck: decidedRecord(
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                    ),
                },
                org,
                { returnDocument: false },
            ],
        ]);
        expect(result.persisted).toEqual([]);
    });

    it('records what the model could not decide as unmeasured, leaving the status alone', async () => {
        aiAnalysisService.checkSuggestionImplementation.mockResolvedValue({
            verdicts: [],
            unmeasured: [{ id: 's-1', reason: 'invalid_output' }],
        });

        const result = await check(
            [sent('s-1')],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(writesFor('s-1')).toEqual([
            [
                's-1',
                { implementationCheck: unmeasuredRecord('invalid_output') },
                org,
                { returnDocument: false },
            ],
        ]);
        expect(result.unmeasured).toEqual([
            { id: 's-1', reason: 'invalid_output' },
        ]);
    });

    it('marks one file llm_error when its call throws, and still decides the others', async () => {
        aiAnalysisService.checkSuggestionImplementation.mockImplementation(
            async ({ file, suggestions }) => {
                if (file.filename === 'src/bad.ts') throw new Error('boom');
                return {
                    verdicts: suggestions.map((s) => ({
                        id: s.id,
                        status: ImplementationStatus.IMPLEMENTED,
                    })),
                    unmeasured: [],
                };
            },
        );

        const result = await check(
            [sent('s-bad', 'src/bad.ts'), sent('s-good', 'src/good.ts')],
            [
                { filename: 'src/bad.ts', patch: 'p1' },
                { filename: 'src/good.ts', patch: 'p2' },
            ],
        );

        expect(result.unmeasured).toEqual([
            { id: 's-bad', reason: 'llm_error' },
        ]);
        expect(result.persisted).toEqual([
            {
                id: 's-good',
                implementationStatus: ImplementationStatus.IMPLEMENTED,
            },
        ]);
    });

    it.each([
        ['the whole PR', 'full'],
        ['no review to diff from', 'none'],
    ])(
        'records diff_unavailable without asking the model when the diff is %s',
        async (_, diffSource) => {
            const result = await check(
                [sent('s-1', 'app/a.rb'), sent('s-2', 'app/elsewhere.rb')],
                [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
                diffSource,
            );

            expect(
                aiAnalysisService.checkSuggestionImplementation,
            ).not.toHaveBeenCalled();
            expect(result.unmeasured).toEqual([
                { id: 's-1', reason: 'diff_unavailable' },
            ]);
            expect(writesFor('s-1')).toEqual([
                [
                    's-1',
                    {
                        implementationCheck:
                            unmeasuredRecord('diff_unavailable'),
                    },
                    org,
                    { returnDocument: false },
                ],
            ]);
            expect(writesFor('s-2')).toEqual([]);
        },
    );

    it('records diff_unavailable for a changed file the provider sent without a patch', async () => {
        answerAll(ImplementationStatus.IMPLEMENTED);

        const result = await check(
            [sent('s-1', 'app/a.rb'), sent('s-2', 'app/b.rb')],
            [
                { filename: 'app/a.rb' },
                { filename: 'app/b.rb', patch: '@@ -1 +1 @@' },
            ],
        );

        expect(result.unmeasured).toEqual([
            { id: 's-1', reason: 'diff_unavailable' },
        ]);
        expect(result.decided).toBe(1);
    });

    it('records diff_too_large without asking the model when the patch alone exceeds the context window', async () => {
        permissionValidationService.resolveTaskSlot.mockResolvedValue({
            provider: 'openai',
            model: 'gpt-x',
            maxInputTokens: 1000,
        });

        const result = await check(
            [sent('s-1', 'app/a.rb')],
            [{ filename: 'app/a.rb', patch: 'x'.repeat(10_000) }],
        );

        expect(
            aiAnalysisService.checkSuggestionImplementation,
        ).not.toHaveBeenCalled();
        expect(result.unmeasured).toEqual([
            { id: 's-1', reason: 'diff_too_large' },
        ]);
    });

    it('counts what the prompt carries for each suggestion, not just the patch, against the context window', async () => {
        permissionValidationService.resolveTaskSlot.mockResolvedValue({
            provider: 'openai',
            model: 'gpt-x',
            maxInputTokens: 1000,
        });
        // The patch alone fits (500 of 750 tokens); twenty suggestions do not.
        const suggestions = Array.from({ length: 20 }, (_, i) =>
            sent(`s-${i}`, 'app/a.rb', { existingCode: 'y'.repeat(200) }),
        );

        const result = await check(suggestions, [
            { filename: 'app/a.rb', patch: 'x'.repeat(1_500) },
        ]);

        expect(
            aiAnalysisService.checkSuggestionImplementation,
        ).not.toHaveBeenCalled();
        expect(result.unmeasured).toHaveLength(20);
        expect(
            result.unmeasured.every((u) => u.reason === 'diff_too_large'),
        ).toBe(true);
    });

    it('keeps the last decided verdict when a later check cannot decide', async () => {
        aiAnalysisService.checkSuggestionImplementation.mockResolvedValue({
            verdicts: [],
            unmeasured: [{ id: 's-1', reason: 'llm_error' }],
        });

        await check(
            [
                sent('s-1', 'app/a.rb', {
                    implementationCheck: {
                        checkedAt: '2026-11-01T00:00:00.000Z',
                        outcome: 'decided',
                        verdict: ImplementationStatus.NOT_IMPLEMENTED,
                    },
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(writesFor('s-1')).toEqual([
            [
                's-1',
                {
                    implementationCheck: {
                        ...unmeasuredRecord('llm_error'),
                        verdict: ImplementationStatus.NOT_IMPLEMENTED,
                    },
                },
                org,
                { returnDocument: false },
            ],
        ]);
    });

    it('reads a legacy spelling of the stored status: never re-checks an implemented one, never lowers one', async () => {
        answerAll(ImplementationStatus.NOT_IMPLEMENTED);

        const result = await check(
            [
                sent('legacy-done', 'app/a.rb', {
                    implementationStatus: 'IMPLEMENTED',
                }),
                sent('legacy-partial', 'app/a.rb', {
                    implementationStatus: 'Partially Implemented',
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        const asked =
            aiAnalysisService.checkSuggestionImplementation.mock.calls[0][0].suggestions.map(
                (x: { id: string }) => x.id,
            );
        expect(asked).toEqual(['legacy-partial']);
        expect(
            writesFor('legacy-partial').some(
                ([, data]) => 'implementationStatus' in data,
            ),
        ).toBe(false);
        expect(result.persisted).toEqual([]);
    });
});
