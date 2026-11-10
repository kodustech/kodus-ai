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

describe('SuggestionService.checkImplementedSuggestions', () => {
    let aiAnalysisService: { validateImplementedSuggestions: jest.Mock };
    let pullRequestService: { updateSuggestion: jest.Mock };
    let permissionValidationService: { resolveTaskSlot: jest.Mock };
    let service: SuggestionService;

    beforeEach(() => {
        aiAnalysisService = {
            validateImplementedSuggestions: jest.fn().mockResolvedValue([]),
        };
        pullRequestService = {
            updateSuggestion: jest.fn().mockResolvedValue(null),
        };
        permissionValidationService = {
            resolveTaskSlot: jest.fn().mockResolvedValue({ id: 'slot' }),
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

    const check = (savedSuggestions: unknown[], changedFiles: unknown[]) =>
        service.checkImplementedSuggestions({
            organizationAndTeamData: org,
            prNumber: 42,
            changedFiles: changedFiles as any,
            savedSuggestions: savedSuggestions as any,
        });

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
        });
        expect(
            aiAnalysisService.validateImplementedSuggestions,
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
        });
    });

    it('skips with NO_PATCH when the changed files carry no patch', async () => {
        const result = await check(
            [sent('s-1', 'app/a.rb')],
            [{ filename: 'app/a.rb' }],
        );

        expect(result).toEqual({
            skipped: 'NO_PATCH',
            checked: 1,
            persisted: [],
        });
    });

    it('hands the model only the fields it needs, not the stored comment data', async () => {
        await check(
            [
                sent('s-1', 'app/a.rb', {
                    language: 'ruby',
                    existingCode: 'a = 1',
                    improvedCode: 'a = 2',
                    label: 'bug',
                    severity: 'high',
                    comment: { id: 123, pullRequestReviewId: 456 },
                    rankScore: 100,
                }),
            ],
            [{ filename: 'app/a.rb', patch: '@@ -1 +1 @@' }],
        );

        expect(
            aiAnalysisService.validateImplementedSuggestions.mock.calls[0][4],
        ).toEqual([
            {
                id: 's-1',
                relevantFile: 'app/a.rb',
                language: 'ruby',
                existingCode: 'a = 1',
                improvedCode: 'a = 2',
            },
        ]);
    });

    it('checks suggestions on changed files only, persists what comes back and counts every candidate', async () => {
        aiAnalysisService.validateImplementedSuggestions.mockResolvedValue([
            {
                id: 's-index',
                implementationStatus: ImplementationStatus.IMPLEMENTED,
            },
        ]);

        const result = await check(
            [
                sent('s-index', 'src/index.ts'),
                sent('s-other', 'src/other.ts'),
                sent('s-partial', 'src/utils.ts', {
                    implementationStatus:
                        ImplementationStatus.PARTIALLY_IMPLEMENTED,
                }),
            ],
            [
                { filename: 'src/index.ts', patch: 'patch1' },
                { filename: 'src/utils.ts', patch: 'patch2' },
            ],
        );

        const [, , , codePatch, passed] =
            aiAnalysisService.validateImplementedSuggestions.mock.calls[0];
        expect(passed.map((s: { id: string }) => s.id)).toEqual([
            's-index',
            's-partial',
        ]);
        expect(codePatch).toBe(
            'File: src/index.ts\npatch1\n\nFile: src/utils.ts\npatch2',
        );
        expect(pullRequestService.updateSuggestion).toHaveBeenCalledWith(
            's-index',
            expect.objectContaining({
                implementationStatus: ImplementationStatus.IMPLEMENTED,
            }),
            org,
        );
        expect(result).toEqual({
            checked: 3,
            persisted: [
                {
                    id: 's-index',
                    implementationStatus: ImplementationStatus.IMPLEMENTED,
                },
            ],
        });
    });
});
