import { Test, TestingModule } from '@nestjs/testing';
import { FetchChangedFilesStage } from './fetch-changed-files.stage';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';

describe('FetchChangedFilesStage', () => {
    let stage: FetchChangedFilesStage;
    let mockPullRequestManagerService: any;
    let context: CodeReviewPipelineContext;

    beforeEach(async () => {
        mockPullRequestManagerService = {
            getChangedFilesMetadata: jest.fn(),
            enrichFilesWithContent: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FetchChangedFilesStage,
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestManagerService,
                },
            ],
        }).compile();

        stage = module.get<FetchChangedFilesStage>(FetchChangedFilesStage);

        context = {
            pullRequest: { number: 1 } as any,
            repository: { id: 'repo-1', name: 'repo' } as any,
            organizationAndTeamData: {} as any,
            codeReviewConfig: { ignorePaths: [] },
            pipelineMetadata: {},
        } as CodeReviewPipelineContext;
    });

    it('should skip if no files changed (using PipelineReasons)', async () => {
        // Mock no files
        mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
            [],
        );

        const result = await stage.execute(context);

        expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);

        const expectedMessage = StageMessageHelper.skippedWithReason(
            PipelineReasons.FILES.NO_CHANGES,
        );

        expect(result.statusInfo.message).toBe(expectedMessage);
    });

    it('should skip if all files are ignored (using PipelineReasons)', async () => {
        context.codeReviewConfig.ignorePaths = ['**/*.js'];
        const files = [{ filename: 'file.js' }];

        mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
            files,
        );

        const result = await stage.execute(context);

        expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);

        const expectedMessage = StageMessageHelper.skippedWithReason(
            PipelineReasons.FILES.ALL_IGNORED,
            'Ignored: file.js',
        );

        expect(result.statusInfo.message).toBe(expectedMessage);
        expect(result.ignoredFiles).toEqual(['file.js']);
    });

    it('should populate ignoredFiles and proceed if some files are valid', async () => {
        context.codeReviewConfig.ignorePaths = ['**/*.js'];
        const files = [
            { filename: 'file.js' },
            { filename: 'file.ts', patch: 'some patch', status: 'modified' },
        ];

        mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
            files,
        );
        mockPullRequestManagerService.enrichFilesWithContent.mockResolvedValue([
            { filename: 'file.ts', patch: 'some patch', status: 'modified' },
        ]);

        const result = await stage.execute(context);

        expect(result.ignoredFiles).toEqual(['file.js']);
        expect(result.changedFiles).toHaveLength(1);
        expect(result.changedFiles[0].filename).toBe('file.ts');
    });

    describe('file-count limits per engine', () => {
        const buildFiles = (n: number) =>
            Array(n)
                .fill(null)
                .map((_, i) => ({
                    filename: `file${i}.ts`,
                    patch: 'p',
                    status: 'modified',
                }));

        describe('legacy engine (default — useAgentEngine not set)', () => {
            it('skips at 351 files with limit=350 in the message', async () => {
                mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                    buildFiles(351),
                );

                const result = await stage.execute(context);

                expect(result.statusInfo.status).toBe(
                    AutomationStatus.SKIPPED,
                );
                expect(result.statusInfo.message).toBe(
                    StageMessageHelper.skippedWithReason(
                        PipelineReasons.FILES.TOO_MANY,
                        'Count: 351, Limit: 350',
                    ),
                );
            });

            it('accepts exactly 350 files (boundary)', async () => {
                const files = buildFiles(350);
                mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                    files,
                );
                mockPullRequestManagerService.enrichFilesWithContent.mockResolvedValue(
                    files,
                );

                const result = await stage.execute(context);

                expect(result.statusInfo).toBeUndefined();
                expect(result.changedFiles).toHaveLength(350);
            });
        });

        describe('agent engine (pipelineMetadata.useAgentEngine = true)', () => {
            beforeEach(() => {
                context.pipelineMetadata = { useAgentEngine: true } as any;
            });

            it('accepts 501 files (above the legacy 350 limit)', async () => {
                const files = buildFiles(501);
                mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                    files,
                );
                mockPullRequestManagerService.enrichFilesWithContent.mockResolvedValue(
                    files,
                );

                const result = await stage.execute(context);

                expect(result.statusInfo).toBeUndefined();
                expect(result.changedFiles).toHaveLength(501);
            });

            it('accepts exactly 2000 files (boundary)', async () => {
                const files = buildFiles(2000);
                mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                    files,
                );
                mockPullRequestManagerService.enrichFilesWithContent.mockResolvedValue(
                    files,
                );

                const result = await stage.execute(context);

                expect(result.statusInfo).toBeUndefined();
                expect(result.changedFiles).toHaveLength(2000);
            });

            it('skips at 2001 files with limit=2000 in the message', async () => {
                mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                    buildFiles(2001),
                );

                const result = await stage.execute(context);

                expect(result.statusInfo.status).toBe(
                    AutomationStatus.SKIPPED,
                );
                expect(result.statusInfo.message).toBe(
                    StageMessageHelper.skippedWithReason(
                        PipelineReasons.FILES.TOO_MANY,
                        'Count: 2001, Limit: 2000',
                    ),
                );
            });
        });
    });

    it('should ignore lastAnalyzedCommit when forceFullRerun is enabled', async () => {
        context.lastExecution = { lastAnalyzedCommit: 'sha-prev' };
        context.pipelineMetadata = { forceFullRerun: true } as any;

        mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
            [],
        );

        await stage.execute(context);

        expect(
            mockPullRequestManagerService.getChangedFilesMetadata,
        ).toHaveBeenCalledWith(
            context.organizationAndTeamData,
            context.repository,
            context.pullRequest,
            undefined,
        );
    });
});
