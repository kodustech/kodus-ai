import { SUGGESTION_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { FILE_REVIEW_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/file-review-context-preparation.interface';
import { KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN } from '@libs/core/domain/interfaces/kody-fine-tuning-context-preparation.interface';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import { GraphContentFormatter } from '@libs/code-review/infrastructure/adapters/services/graphContentFormatter.service';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { Test, TestingModule } from '@nestjs/testing';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ProcessFilesReview } from './process-files-review.stage';

describe('ProcessFilesReview', () => {
    let stage: ProcessFilesReview;
    let context: CodeReviewPipelineContext;
    let codeAnalysisOrchestrator: CodeAnalysisOrchestrator;
    let fileReviewContextPreparation: any;

    beforeEach(async () => {
        const mockSuggestionService = {
            analyzeSuggestionsSeverity: jest.fn(),
            filterCodeSuggestionsByReviewOptions: jest.fn(),
            filterSuggestionsCodeDiff: jest.fn(),
            getDiscardedSuggestions: jest.fn(),
            calculateSuggestionRankScore: jest.fn(),
            filterSuggestionsSafeGuard: jest.fn(),
            filterSuggestionsBySeverityLevel: jest.fn(),
        };

        const mockPullRequestService = {
            findSuggestionsByPRAndFilename: jest.fn(),
        };

        fileReviewContextPreparation = {
            prepareFileContext: jest.fn(),
        };

        const mockKodyFineTuningContextPreparation = {
            prepareKodyFineTuningContext: jest.fn(),
        };

        const mockCodeAnalysisOrchestrator = {
            executeStandardAnalysis: jest.fn(),
            executeKodyRulesAnalysis: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ProcessFilesReview,
                {
                    provide: SUGGESTION_SERVICE_TOKEN,
                    useValue: mockSuggestionService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: mockPullRequestService,
                },
                {
                    provide: FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
                    useValue: fileReviewContextPreparation,
                },
                {
                    provide: KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
                    useValue: mockKodyFineTuningContextPreparation,
                },
                {
                    provide: CodeAnalysisOrchestrator,
                    useValue: mockCodeAnalysisOrchestrator,
                },
                {
                    provide: GraphContentFormatter,
                    useValue: {
                        formatContent: jest.fn().mockResolvedValue(new Map()),
                    },
                },
            ],
        }).compile();

        stage = module.get<ProcessFilesReview>(ProcessFilesReview);
        codeAnalysisOrchestrator = module.get<CodeAnalysisOrchestrator>(
            CodeAnalysisOrchestrator,
        );

        context = {
            pullRequest: { number: 1 } as any,
            repository: { id: 'repo-1', name: 'repo' } as any,
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            changedFiles: [{ filename: 'test-file.ts' } as FileChange],
            errors: [],
        } as CodeReviewPipelineContext;
    });

    it('should capture errors in executeFileAnalysis without the misleading "(Check model config)" suffix (#1105)', async () => {
        const error = new Error('Analysis failed');
        (
            codeAnalysisOrchestrator.executeStandardAnalysis as jest.Mock
        ).mockRejectedValue(error);

        // Mock prepareFileContext to return a context so executeFileAnalysis is called
        (
            fileReviewContextPreparation.prepareFileContext as jest.Mock
        ).mockResolvedValue({
            fileContext: {
                fileChangeContext: {
                    file: { filename: 'test-file.ts' },
                    relevantContent: 'content',
                    patchWithLinesStr: 'patch',
                    hasRelevantContent: true,
                },
                organizationAndTeamData: context.organizationAndTeamData,
                pullRequest: context.pullRequest,
            },
        });

        const result = await stage.execute(context);

        expect(
            fileReviewContextPreparation.prepareFileContext,
        ).toHaveBeenCalled();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual(
            expect.objectContaining({
                stage: 'FileAnalysisStage',
                substage: 'test-file.ts',
                error: expect.objectContaining({
                    message: 'File analysis failed: Analysis failed',
                }),
                metadata: {
                    filename: 'test-file.ts',
                    isTimeout: false,
                },
            }),
        );
    });

    it('should keep non-blocking behavior and append pipeline error when batch analysis crashes', async () => {
        const error = new Error('Batch analysis crashed');
        jest.spyOn(
            stage as any,
            'analyzeChangedFilesInBatches',
        ).mockRejectedValue(error);

        const result = await stage.execute(context);

        expect(result.validSuggestions).toEqual([]);
        expect(result.discardedSuggestions).toEqual([]);
        expect(result.fileMetadata).toBeInstanceOf(Map);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toEqual(
            expect.objectContaining({
                stage: 'FileAnalysisStage',
                substage: 'executeStage',
                error,
            }),
        );
    });

    it('should pass per-file documentation context into prepared file context', async () => {
        context.changedFiles = [
            {
                filename: 'test-file.ts',
                patch: '@@ -1,1 +1,1 @@',
                patchWithLinesStr: '@@ -1,1 +1,1 @@',
                fileContent: 'const value = 1;',
            } as FileChange,
        ];

        (context as any).documentationByFile = {
            'test-file.ts': [
                {
                    query: 'nestjs controller decorators',
                    title: 'NestJS Controllers',
                    url: 'https://docs.nestjs.com/controllers',
                    snippet: 'Controller docs',
                    source: 'exa-search',
                },
            ],
        };

        (
            codeAnalysisOrchestrator.executeStandardAnalysis as jest.Mock
        ).mockResolvedValue({
            codeSuggestions: [],
            codeReviewModelUsed: {},
        });
        (
            codeAnalysisOrchestrator.executeKodyRulesAnalysis as jest.Mock
        ).mockResolvedValue({ codeSuggestions: [] });

        (
            fileReviewContextPreparation.prepareFileContext as jest.Mock
        ).mockImplementation(async (_file, analysisContext) => ({
            fileContext: {
                ...analysisContext,
                fileChangeContext: {
                    file: { filename: 'test-file.ts' },
                    relevantContent: 'content',
                    patchWithLinesStr: '@@ -1,1 +1,1 @@',
                    hasRelevantContent: true,
                },
            },
        }));

        await stage.execute(context);

        expect(
            fileReviewContextPreparation.prepareFileContext,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ filename: 'test-file.ts' }),
            expect.objectContaining({
                documentationContext: [
                    expect.objectContaining({
                        query: 'nestjs controller decorators',
                    }),
                ],
            }),
        );
    });
});
