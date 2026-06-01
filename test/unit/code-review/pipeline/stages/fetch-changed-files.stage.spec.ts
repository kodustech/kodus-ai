import { Test, TestingModule } from '@nestjs/testing';

import { FetchChangedFilesStage } from '@libs/code-review/pipeline/stages/fetch-changed-files.stage';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('FetchChangedFilesStage', () => {
    let stage: FetchChangedFilesStage;

    const mockPullRequestHandlerService = {
        getChangedFiles: jest.fn(),
        getChangedFilesMetadata: jest.fn(),
        enrichFilesWithContent: jest.fn(),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) => ({
        dryRun: { enabled: false },
        organizationAndTeamData: mockOrganizationAndTeamData as any,
        repository: {
            id: 'repo-1',
            name: 'test-repo',
            language: 'typescript',
        } as any,
        branch: 'main',
        pullRequest: {
            number: 123,
            title: 'Test PR',
            base: { repo: { fullName: 'org/repo' }, ref: 'main' },
            repository: {} as any,
            isDraft: false,
            stats: {
                total_additions: 0,
                total_deletions: 0,
                total_files: 0,
                total_lines_changed: 0,
            },
        },
        teamAutomationId: 'team-auto-1',
        origin: 'github',
        action: 'opened',
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            ignorePaths: [],
        } as any,
        preparedFileContexts: [],
        validSuggestions: [],
        discardedSuggestions: [],
        correlationId: 'test-correlation-id',
        ...overrides,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FetchChangedFilesStage,
                {
                    provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
                    useValue: mockPullRequestHandlerService,
                },
            ],
        }).compile();

        stage = module.get<FetchChangedFilesStage>(FetchChangedFilesStage);
        jest.clearAllMocks();
    });

    describe('stage name', () => {
        it('should have correct stage name', () => {
            expect(stage.stageName).toBe('FetchChangedFilesStage');
        });
    });

    describe('fetching changed files', () => {
        it('should fetch and process changed files successfully', async () => {
            const mockFiles: any[] = [
                {
                    filename: 'src/test.ts',
                    status: 'modified',
                    additions: 10,
                    deletions: 5,
                    patch: '@@ -1,5 +1,10 @@\n function test() {\n+  const x = 1;\n }',
                },
                {
                    filename: 'src/utils.ts',
                    status: 'added',
                    additions: 20,
                    deletions: 0,
                    patch: '@@ -0,0 +1,20 @@\n+export function util() {}',
                },
            ];

            // Agora usa preliminaryFiles do context, então não precisa chamar getChangedFilesMetadata
            // Mas se não tiver preliminaryFiles, vai chamar
            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(
                mockPullRequestHandlerService.getChangedFilesMetadata,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                expect.any(Object),
                expect.any(Object),
                undefined,
            );
            expect(
                mockPullRequestHandlerService.enrichFilesWithContent,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                expect.any(Object),
                expect.any(Object),
                mockFiles,
            );
            expect(result.changedFiles).toHaveLength(2);
            expect(result.pullRequest.stats.total_files).toBe(2);
            expect(result.pullRequest.stats.total_additions).toBe(30);
            expect(result.pullRequest.stats.total_deletions).toBe(5);
        });

        it('should reuse preliminaryFiles from context when available', async () => {
            const mockFiles: any[] = [
                {
                    filename: 'src/test.ts',
                    status: 'modified',
                    additions: 10,
                    deletions: 5,
                    patch: '@@ -1,5 +1,10 @@\n function test() {\n+  const x = 1;\n }',
                },
            ];

            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext({
                preliminaryFiles: mockFiles,
            });
            const result = await (stage as any).executeStage(context);

            // Não deve chamar getChangedFilesMetadata pois já tem preliminaryFiles
            expect(
                mockPullRequestHandlerService.getChangedFilesMetadata,
            ).not.toHaveBeenCalled();
            expect(
                mockPullRequestHandlerService.enrichFilesWithContent,
            ).toHaveBeenCalledWith(
                mockOrganizationAndTeamData,
                expect.any(Object),
                expect.any(Object),
                mockFiles,
            );
            expect(result.changedFiles).toHaveLength(1);
        });

        it('should skip when no config is found', async () => {
            const context = createBaseContext({
                codeReviewConfig: undefined,
            });

            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.message).toBe(
                AutomationMessage.NO_CONFIG_IN_CONTEXT,
            );
        });

        it('should skip when no files are returned', async () => {
            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                [],
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.message).toBe('No Files Changed');
        });

        it('should skip when too many files (over 500)', async () => {
            const manyFiles = Array.from({ length: 501 }, (_, i) => ({
                filename: `file${i}.ts`,
                status: 'modified',
                additions: 1,
                deletions: 0,
                patch: '@@ -1,1 +1,1 @@',
            }));

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                manyFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.message).toContain('Too Many Files');
            expect(result.statusInfo.message).toContain('Count: 501');
        });

        it('should filter files locally using ignorePaths', async () => {
            const mockFiles = [
                {
                    filename: 'src/test.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    patch: '',
                },
                {
                    filename: 'node_modules/pkg/index.js',
                    status: 'modified',
                    additions: 10,
                    deletions: 0,
                    patch: '',
                },
                {
                    filename: 'dist/bundle.js',
                    status: 'added',
                    additions: 100,
                    deletions: 0,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            // enrichFilesWithContent será chamado apenas com arquivos filtrados
            mockPullRequestHandlerService.enrichFilesWithContent.mockImplementation(
                (_, __, ___, files) => Promise.resolve(files),
            );

            const ignorePaths = ['node_modules/**', 'dist/**'];
            const context = createBaseContext({
                codeReviewConfig: {
                    ignorePaths,
                } as any,
            });

            const result = await (stage as any).executeStage(context);

            // enrichFilesWithContent deve ser chamado apenas com o arquivo não ignorado
            expect(
                mockPullRequestHandlerService.enrichFilesWithContent,
            ).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Object),
                expect.any(Object),
                [expect.objectContaining({ filename: 'src/test.ts' })],
            );
            expect(result.changedFiles).toHaveLength(1);
            expect(result.changedFiles[0].filename).toBe('src/test.ts');
        });

        it('should pass lastAnalyzedCommit when fetching from API', async () => {
            const mockFiles = [
                {
                    filename: 'src/test.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const lastCommit = 'abc123';
            const context = createBaseContext({
                lastExecution: {
                    lastAnalyzedCommit: lastCommit,
                },
            });

            await (stage as any).executeStage(context);

            expect(
                mockPullRequestHandlerService.getChangedFilesMetadata,
            ).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Object),
                expect.any(Object),
                lastCommit,
            );
        });
    });

    describe('calculating stats', () => {
        it('should calculate correct stats for PR', async () => {
            const mockFiles = [
                {
                    filename: 'a.ts',
                    status: 'modified',
                    additions: 10,
                    deletions: 3,
                    patch: '',
                },
                {
                    filename: 'b.ts',
                    status: 'added',
                    additions: 50,
                    deletions: 0,
                    patch: '',
                },
                {
                    filename: 'c.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 20,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.pullRequest.stats).toEqual({
                total_additions: 65,
                total_deletions: 23,
                total_files: 3,
                total_lines_changed: 88,
            });
        });

        it('should handle files without additions/deletions', async () => {
            const mockFiles = [
                { filename: 'a.ts', status: 'modified', patch: '' },
                {
                    filename: 'b.ts',
                    status: 'modified',
                    additions: undefined,
                    deletions: undefined,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.pullRequest.stats.total_additions).toBe(0);
            expect(result.pullRequest.stats.total_deletions).toBe(0);
            expect(result.pullRequest.stats.total_files).toBe(2);
        });
    });

    describe('processing patches with line numbers', () => {
        it('should add patchWithLinesStr to files with valid patches', async () => {
            const mockFiles = [
                {
                    filename: 'test.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    patch: '@@ -1,5 +1,8 @@\n function test() {\n+  const x = 1;\n+  const y = 2;\n }',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles[0].patchWithLinesStr).toBeDefined();
            expect(typeof result.changedFiles[0].patchWithLinesStr).toBe(
                'string',
            );
        });

        it('should handle files without patches', async () => {
            const mockFiles = [
                {
                    filename: 'binary.png',
                    status: 'added',
                    additions: 0,
                    deletions: 0,
                    patch: undefined,
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles[0]).toEqual(mockFiles[0]);
        });

        it('should handle malformed patches gracefully', async () => {
            const mockFiles = [
                {
                    filename: 'malformed.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    patch: 'this is not a valid patch format',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            // Should not throw
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles).toBeDefined();
        });
    });

    describe('edge cases', () => {
        it('should handle exactly 350 files (at the legacy limit)', async () => {
            const files = Array.from({ length: 350 }, (_, i) => ({
                filename: `file${i}.ts`,
                status: 'modified',
                additions: 1,
                deletions: 0,
                patch: '',
            }));

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                files,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                files,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles).toHaveLength(350);
            expect(result.statusInfo).toBeUndefined(); // No skip status
        });

        it('should SKIP at 351 files on legacy engine (over the limit)', async () => {
            const files = Array.from({ length: 351 }, (_, i) => ({
                filename: `file${i}.ts`,
                status: 'modified',
                additions: 1,
                deletions: 0,
                patch: '',
            }));

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                files,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo?.status).toBe(AutomationStatus.SKIPPED);
        });

        it('should handle null returned from getChangedFilesMetadata', async () => {
            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                null,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
        });

        it('should handle files with special characters in path', async () => {
            const mockFiles = [
                {
                    filename: 'src/path with spaces/test-file.spec.ts',
                    status: 'modified',
                    additions: 10,
                    deletions: 5,
                    patch: '@@ -1,1 +1,1 @@',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles).toHaveLength(1);
            expect(result.changedFiles[0].filename).toBe(
                'src/path with spaces/test-file.spec.ts',
            );
        });

        it('should handle different file statuses', async () => {
            const mockFiles = [
                {
                    filename: 'added.ts',
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    patch: '',
                },
                {
                    filename: 'modified.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 3,
                    patch: '',
                },
                {
                    filename: 'renamed.ts',
                    status: 'renamed',
                    additions: 0,
                    deletions: 0,
                    patch: '',
                },
                {
                    filename: 'deleted.ts',
                    status: 'removed',
                    additions: 0,
                    deletions: 20,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );
            mockPullRequestHandlerService.enrichFilesWithContent.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext();
            const result = await (stage as any).executeStage(context);

            expect(result.changedFiles).toHaveLength(4);
        });

        it('should skip when all files are ignored', async () => {
            const mockFiles = [
                {
                    filename: 'node_modules/pkg/index.js',
                    status: 'modified',
                    additions: 10,
                    deletions: 0,
                    patch: '',
                },
                {
                    filename: 'dist/bundle.js',
                    status: 'added',
                    additions: 100,
                    deletions: 0,
                    patch: '',
                },
            ];

            mockPullRequestHandlerService.getChangedFilesMetadata.mockResolvedValue(
                mockFiles,
            );

            const context = createBaseContext({
                codeReviewConfig: {
                    ignorePaths: ['node_modules/**', 'dist/**'],
                } as any,
            });

            const result = await (stage as any).executeStage(context);

            expect(result.statusInfo.status).toBe(AutomationStatus.SKIPPED);
            expect(result.statusInfo.message).toContain('All Files Ignored');
            expect(result.statusInfo.message).toContain(
                'node_modules/pkg/index.js',
            );
            // enrichFilesWithContent não deve ser chamado pois todos os arquivos foram filtrados
            expect(
                mockPullRequestHandlerService.enrichFilesWithContent,
            ).not.toHaveBeenCalled();
        });
    });
});
