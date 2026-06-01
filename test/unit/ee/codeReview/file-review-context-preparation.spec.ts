import { Test, TestingModule } from '@nestjs/testing';
import { FileReviewContextPreparation } from '@/ee/codeReview/fileReviewContextPreparation/file-review-context-preparation.service';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '@/code-review/infrastructure/adapters/services/llmAnalysis.service';
import {
    ReviewModeResponse,
    ReviewModeConfig,
} from '@/core/infrastructure/config/types/general/codeReview.type';

describe('FileReviewContextPreparation (EE)', () => {
    let service: FileReviewContextPreparation;
    const mockAiAnalysisService = {
        selectReviewMode: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FileReviewContextPreparation,
                {
                    provide: LLM_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockAiAnalysisService,
                },
            ],
        }).compile();

        service = module.get<FileReviewContextPreparation>(
            FileReviewContextPreparation,
        );
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('getRelevantFileContent', () => {
        it('should return full file content and hasRelevantContent false when no graph content', async () => {
            const file = {
                filename: 'test.ts',
                fileContent: 'const a = 1;',
                content: 'const a = 1;',
            } as any;

            const context = {
                organizationAndTeamData: {
                    organizationId: 'org',
                    teamId: 'team',
                },
            } as any;

            // Accessing protected method for unit test
            const result = await (service as any).getRelevantFileContent(
                file,
                context,
            );

            expect(result.relevantContent).toBe('const a = 1;');
            expect(result.hasRelevantContent).toBe(false);
        });

        it('should fallback to file.content if fileContent is missing', async () => {
            const file = {
                filename: 'test.ts',
                content: 'const b = 2;',
            } as any;

            const context = {
                organizationAndTeamData: {},
            } as any;

            const result = await (service as any).getRelevantFileContent(
                file,
                context,
            );

            expect(result.relevantContent).toBe('const b = 2;');
            expect(result.hasRelevantContent).toBe(false);
        });
    });

    describe('determineReviewMode', () => {
        it('should return HEAVY_MODE by default if no special config', async () => {
            const options = {
                context: {
                    codeReviewConfig: {
                        reviewModeConfig: null,
                    },
                },
            } as any;

            const result = await (service as any).determineReviewMode(options);
            expect(result).toBe(ReviewModeResponse.HEAVY_MODE);
        });

        it('should always return HEAVY_MODE regardless of config', async () => {
            const options = {
                context: {
                    organizationAndTeamData: {},
                    pullRequest: { number: 1 },
                    codeReviewConfig: {
                        reviewModeConfig: ReviewModeConfig.LIGHT_MODE_FULL,
                    },
                },
                fileChangeContext: { file: {} },
                patch: 'diff',
            } as any;

            const result = await (service as any).determineReviewMode(options);

            expect(
                mockAiAnalysisService.selectReviewMode,
            ).not.toHaveBeenCalled();
            expect(result).toBe(ReviewModeResponse.HEAVY_MODE);
        });
    });
});
