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

    describe('ignored files a custom agent names (#2172)', () => {
        const PATCH =
            '@@ -1,2 +1,2 @@\n {\n-  "name": "hive"\n+  "name": "apiary"';
        const files = [
            { filename: 'src/hive.ts', status: 'modified', patch: PATCH },
            { filename: 'package.json', status: 'modified', patch: PATCH },
            {
                filename: 'infra/prod/main.tf',
                status: 'modified',
                patch: PATCH,
            },
            { filename: 'old.json', status: 'removed', patch: PATCH },
        ];
        const agent = (include: string[]) => ({
            id: 'agent-1',
            name: 'Manifest',
            enabled: true,
            instructions: 'Check the manifest.',
            scope: { include },
        });
        const withContent = async (_o: any, _r: any, _p: any, list: any[]) =>
            list.map((f) => ({
                ...f,
                fileContent: `content of ${f.filename}`,
            }));

        beforeEach(() => {
            context.codeReviewConfig.ignorePaths = [
                'package.json',
                '**/prod/**',
            ];
            mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                files,
            );
            mockPullRequestManagerService.enrichFilesWithContent.mockImplementation(
                withContent,
            );
        });

        it('fetches content and line numbers for the ignored file an agent names', async () => {
            context.codeReviewConfig.customAgents = [
                agent(['src/**', 'package.json']),
            ] as any;

            const result = await stage.execute(context);

            const fetched =
                mockPullRequestManagerService.enrichFilesWithContent.mock.calls.map(
                    (call: any[]) => call[3].map((f: any) => f.filename),
                );
            expect(fetched).toEqual([['src/hive.ts'], ['package.json']]);
            expect(result.changedFiles.map((f) => f.filename)).toEqual([
                'src/hive.ts',
            ]);
            const byName = new Map(
                result.ignoredFileChanges.map((f) => [f.filename, f]),
            );
            expect([...byName.keys()]).toEqual([
                'package.json',
                'infra/prod/main.tf',
            ]);
            expect(byName.get('package.json')).toMatchObject({
                fileContent: 'content of package.json',
                patchWithLinesStr: expect.stringContaining('apiary'),
            });
            expect(byName.get('infra/prod/main.tf')).toEqual(files[2]);
        });

        it('fetches nothing more without a custom agent or for a broad glob', async () => {
            for (const customAgents of [undefined, [agent(['**/*'])]]) {
                mockPullRequestManagerService.enrichFilesWithContent.mockClear();
                const result = await stage.execute({
                    ...context,
                    codeReviewConfig: {
                        ...context.codeReviewConfig,
                        customAgents: customAgents as any,
                    },
                });

                expect(
                    mockPullRequestManagerService.enrichFilesWithContent,
                ).toHaveBeenCalledTimes(1);
                expect(result.ignoredFileChanges).toEqual([files[1], files[2]]);
            }
        });

        it('reviews a PR whose changed files are all ignored when an agent names one', async () => {
            mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                files.slice(1),
            );
            context.codeReviewConfig.customAgents = [
                agent(['package.json']),
            ] as any;

            const result = await stage.execute(context);

            expect(result.statusInfo).toBeUndefined();
            expect(result.changedFiles).toEqual([]);
            expect(
                result.ignoredFileChanges.find(
                    (f) => f.filename === 'package.json',
                ),
            ).toMatchObject({ fileContent: 'content of package.json' });
        });

        it('still skips an all-ignored PR no agent names a file of', async () => {
            mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                files.slice(1),
            );
            for (const customAgents of [undefined, [agent(['**/*.json'])]]) {
                const result = await stage.execute({
                    ...context,
                    codeReviewConfig: {
                        ...context.codeReviewConfig,
                        customAgents: customAgents as any,
                    },
                });

                expect(result.statusInfo).toMatchObject({
                    status: AutomationStatus.SKIPPED,
                    message: expect.stringContaining('package.json'),
                });
            }
        });

        it('counts the ignored files an agent names toward the file ceiling', async () => {
            const reviewed = Array.from({ length: 1999 }, (_, i) => ({
                filename: `src/file-${i}.ts`,
                status: 'modified',
                patch: PATCH,
            }));
            mockPullRequestManagerService.getChangedFilesMetadata.mockResolvedValue(
                [...reviewed, ...files.slice(1)],
            );
            context.codeReviewConfig.customAgents = [
                agent(['package.json', 'infra/**/*.tf']),
            ] as any;

            const result = await stage.execute(context);

            expect(result.statusInfo).toEqual({
                status: AutomationStatus.SKIPPED,
                message: StageMessageHelper.skippedWithReason(
                    PipelineReasons.FILES.TOO_MANY,
                    'Count: 2001, Limit: 2000',
                ),
            });
            expect(
                mockPullRequestManagerService.enrichFilesWithContent,
            ).not.toHaveBeenCalled();
        });
    });
});
