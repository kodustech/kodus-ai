import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AzureReposService } from '@libs/platform/infrastructure/services/azureRepos/azureRepos.service';
import { AzureReposRequestHelper } from '@libs/platform/infrastructure/services/azureRepos/azure-repos-request-helper';
import { INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (val: string) => val,
    encrypt: (val: string) => val,
}));

jest.mock('@libs/ee/configs/environment', () => ({
    environment: {},
}));

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@libs/common/utils/webhooks/webhookTokenCrypto', () => ({
    generateWebhookToken: jest.fn().mockReturnValue('mock-token'),
}));

describe('AzureReposService.getChangedFilesSinceLastCommit - merge commit filtering', () => {
    let service: AzureReposService;

    // Mock AzureReposRequestHelper methods
    const mockGetPullRequestDetails = jest.fn();
    const mockGetDiff = jest.fn();
    const mockGetFileContent = jest.fn();
    const mockMapAzureStatus = jest.fn();
    const mockGetIterations = jest.fn();
    const mockGetChanges = jest.fn();

    const mockAzureReposRequestHelper = {
        getPullRequestDetails: mockGetPullRequestDetails,
        getDiff: mockGetDiff,
        getFileContent: mockGetFileContent,
        mapAzureStatusToFileChangeStatus: mockMapAzureStatus,
        getIterations: mockGetIterations,
        getChanges: mockGetChanges,
    };

    // Mock injected services
    const mockIntegrationService = {
        findOne: jest.fn().mockResolvedValue({ uuid: 'integration-uuid' }),
        getPlatformAuthDetails: jest.fn().mockResolvedValue({
            orgName: 'test-org',
            token: 'test-token',
            authMode: 'token',
        }),
    };

    const mockIntegrationConfigService = {
        findOne: jest.fn(),
    };

    const mockAuthIntegrationService = {};

    const mockConfigService = {
        get: jest.fn(),
    };

    beforeEach(async () => {
        const { MCPManagerService } = jest.requireMock(
            '@libs/mcp-server/services/mcp-manager.service',
        );

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AzureReposService,
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: mockIntegrationService,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: mockIntegrationConfigService,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: mockAuthIntegrationService,
                },
                {
                    provide: AzureReposRequestHelper,
                    useValue: mockAzureReposRequestHelper,
                },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: MCPManagerService, useValue: {} },
            ],
        }).compile();

        service = module.get<AzureReposService>(AzureReposService);

        jest.clearAllMocks();

        // Re-apply default mocks after clearAllMocks
        mockIntegrationService.getPlatformAuthDetails.mockResolvedValue({
            orgName: 'test-org',
            token: 'test-token',
            authMode: 'token',
        });

        // Default: map Azure change types to standard statuses
        mockMapAzureStatus.mockImplementation((status: string) => {
            switch (status.toLowerCase()) {
                case 'add':
                    return 'added';
                case 'edit':
                    return 'modified';
                case 'delete':
                    return 'removed';
                case 'rename':
                    return 'renamed';
                default:
                    return 'changed';
            }
        });
    });

    // === Test fixtures ===

    const organizationAndTeamData = {
        organizationId: 'org-uuid',
        teamId: 'team-uuid',
    };

    const repository = {
        id: 'repo-123',
        name: 'test-repo',
        project: { id: 'project-123' },
    };

    const prNumber = 42;
    const lastCommit = { sha: 'commit-a1-hash' };

    function setupPrResponse(lastMergeSourceCommitId: string) {
        mockGetPullRequestDetails.mockResolvedValue({
            lastMergeSourceCommit: { commitId: lastMergeSourceCommitId },
        });
    }

    function setupDiffResponse(
        changes: Array<{ path: string; changeType: string }>,
    ) {
        mockGetDiff.mockResolvedValue(
            changes.map((c) => ({
                item: { path: c.path, gitObjectType: 'blob' },
                changeType: c.changeType,
            })),
        );
    }

    function setupFileContentResponses(contents: Record<string, string>) {
        mockGetFileContent.mockImplementation(async (params: any) => {
            const path = params.filePath;
            const content = contents[path];
            if (content === undefined) {
                const error: any = new Error('File not found');
                error.status = 404;
                throw error;
            }
            return { content };
        });
    }

    /**
     * Sets up the PR file list (via iterations + changes).
     * This represents only the files that belong to the PR relative to the target branch.
     */
    function setupPrFilesResponse(filePaths: string[]) {
        mockGetIterations.mockResolvedValue([{ id: 1 }]);
        mockGetChanges.mockResolvedValue(
            filePaths.map((path) => ({
                item: { path },
                changeType: 'edit',
            })),
        );
    }

    describe('should exclude files that came from merge commits', () => {
        it('should return only 1 file (the one actually changed on branch A)', async () => {
            // PR head commit
            setupPrResponse('merge-main-hash');

            // getDiff returns 4 file changes (1 real + 3 from branch B via merge)
            setupDiffResponse([
                { path: '/src/app.ts', changeType: 'edit' },
                { path: '/src/feature-b/component1.ts', changeType: 'add' },
                { path: '/src/feature-b/component2.ts', changeType: 'add' },
                { path: '/src/feature-b/component3.ts', changeType: 'add' },
            ]);

            // PR iteration changes: only the file actually changed on branch A
            setupPrFilesResponse(['/src/app.ts']);

            // File contents at both commits
            setupFileContentResponses({
                '/src/app.ts': 'const app = "updated";',
            });

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            // After fix: only returns files that exist in both the diff AND the PR iteration
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('/src/app.ts');
        });

        it('should return null when targetCommitId is not available', async () => {
            mockGetPullRequestDetails.mockResolvedValue({
                lastMergeSourceCommit: null,
            });

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            expect(result).toBeNull();
        });

        it('should return null when no file changes exist', async () => {
            setupPrResponse('head-hash');
            mockGetDiff.mockResolvedValue([]);

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            expect(result).toBeNull();
        });

        it('should filter out non-blob changes', async () => {
            setupPrResponse('head-hash');

            // getDiff returns blob and tree items
            mockGetDiff.mockResolvedValue([
                {
                    item: { path: '/src/app.ts', gitObjectType: 'blob' },
                    changeType: 'edit',
                },
                {
                    item: { path: '/src/folder', gitObjectType: 'tree' },
                    changeType: 'add',
                },
            ]);

            setupPrFilesResponse(['/src/app.ts', '/src/folder']);

            setupFileContentResponses({
                '/src/app.ts': 'content',
            });

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            // Only blob files should be processed
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('/src/app.ts');
        });

        it('should handle large merge with many files from main', async () => {
            const mergeFileCount = 20;
            const realFileCount = 2;

            setupPrResponse('merge-head-hash');

            const changes = [];
            const contents: Record<string, string> = {};
            const prFiles: string[] = [];

            // Real files changed on branch A
            for (let i = 0; i < realFileCount; i++) {
                const path = `/src/real-file-${i}.ts`;
                changes.push({ path, changeType: 'edit' });
                contents[path] = `new content ${i}`;
                prFiles.push(path); // These belong to the PR
            }

            // Files from merge (branch B via main)
            for (let i = 0; i < mergeFileCount; i++) {
                const path = `/src/from-merge/file-${i}.ts`;
                changes.push({ path, changeType: 'add' });
                contents[path] = `// merge content ${i}`;
                // NOT added to prFiles — these came from merge
            }

            setupDiffResponse(changes);
            setupPrFilesResponse(prFiles);
            setupFileContentResponses(contents);

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            // After fix: only returns the 2 real files
            expect(result).toHaveLength(realFileCount);
            expect(
                result.every((f) => f.filename.startsWith('/src/real-file')),
            ).toBe(true);
        });

        it('should preserve file metadata correctly', async () => {
            setupPrResponse('target-commit-hash');

            setupDiffResponse([{ path: '/src/app.ts', changeType: 'edit' }]);

            setupPrFilesResponse(['/src/app.ts']);

            setupFileContentResponses({
                '/src/app.ts': 'const app = "updated";',
            });

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('/src/app.ts');
            expect(result[0].sha).toBe('target-commit-hash');
            expect(result[0].status).toBe('modified');
            expect(result[0].blob_url).toBeNull();
            expect(result[0].raw_url).toBeNull();
            expect(result[0].contents_url).toBeNull();
            // patch should be a unified diff string
            expect(result[0].patch).toBeDefined();
            expect(result[0].content).toBe('const app = "updated";');
        });

        it('should skip files with null path', async () => {
            setupPrResponse('head-hash');

            mockGetDiff.mockResolvedValue([
                {
                    item: { path: '/src/valid.ts', gitObjectType: 'blob' },
                    changeType: 'edit',
                },
                {
                    item: { path: null, gitObjectType: 'blob' },
                    changeType: 'add',
                },
                { item: null, changeType: 'edit' },
            ]);

            setupPrFilesResponse(['/src/valid.ts']);

            setupFileContentResponses({
                '/src/valid.ts': 'valid content',
            });

            const result = await service.getChangedFilesSinceLastCommit({
                organizationAndTeamData: organizationAndTeamData as any,
                repository,
                prNumber,
                lastCommit,
            });

            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('/src/valid.ts');
        });
    });
});
