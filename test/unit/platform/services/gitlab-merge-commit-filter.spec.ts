import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
    INTEGRATION_SERVICE_TOKEN,
    IIntegrationService,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@libs/integrations/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { CacheService } from '@libs/core/cache/cache.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

// Mock external dependencies
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Dynamic import para evitar problemas com o módulo
let GitlabService: any;

describe('GitLab getChangedFilesSinceLastCommit - integration tests for merge commit filtering', () => {
    let gitlabService: any;
    let mockGitlabAPI: any;

    beforeAll(async () => {
        // Import GitlabService dinamicamente
        const module =
            await import('@libs/platform/infrastructure/adapters/services/gitlab.service');
        GitlabService = (module as any).default || module.GitlabService;
    });

    beforeEach(async () => {
        // Setup mock GitLab API
        mockGitlabAPI = {
            MergeRequests: {
                allCommits: jest.fn(),
                allDiffs: jest.fn(),
            },
            Repositories: {
                compare: jest.fn(),
            },
        };

        // Create test module
        const moduleRef = await Test.createTestingModule({
            providers: [
                GitlabService,
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn(),
                    },
                },
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationService>,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IIntegrationConfigService>,
                },
                {
                    provide: AUTH_INTEGRATION_SERVICE_TOKEN,
                    useValue: {
                        findOne: jest.fn(),
                    } as Partial<IAuthIntegrationService>,
                },
                {
                    provide: CacheService,
                    useValue: {
                        get: jest.fn(),
                        set: jest.fn(),
                    },
                },
                {
                    provide: MCPManagerService,
                    useValue: {
                        getManager: jest.fn(),
                    },
                },
            ],
        }).compile();

        gitlabService = moduleRef.get(GitlabService);

        // Mock internal methods
        jest.spyOn(gitlabService, 'getAuthDetails').mockResolvedValue({
            token: 'test-token',
            host: 'gitlab.com',
        });

        jest.spyOn(gitlabService, 'instanceGitlabApi').mockReturnValue(
            mockGitlabAPI,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('should exclude files that came from merge commits', () => {
        it('should return only 1 file (the one actually changed on branch A)', async () => {
            // Setup: Branch A commits
            const commits = [
                { id: 'commit-a1', created_at: '2024-01-02T00:00:00Z' },
                { id: 'commit-a2', created_at: '2024-01-05T00:00:00Z' },
                { id: 'merge-main', created_at: '2024-01-06T00:00:00Z' },
            ];

            // Compare returns 4 files: 1 real change + 3 from merge
            const compareDiffs = [
                {
                    new_path: 'src/app.ts',
                    diff: '@@ -10,2 +10,5 @@\n-    old code\n-    old code 2\n+    new code\n+    new code 2\n+    new code 3\n+    new code 4\n+    new code 5',
                },
                {
                    new_path: 'src/feature-b/component1.ts',
                    diff: '+// Component 1 from branch B',
                    new_file: true,
                },
                {
                    new_path: 'src/feature-b/component2.ts',
                    diff: '+// Component 2 from branch B',
                    new_file: true,
                },
                {
                    new_path: 'src/feature-b/component3.ts',
                    diff: '+// Component 3 from branch B',
                    new_file: true,
                },
            ];

            // MR diffs only includes the real change
            const mrDiffs = [{ new_path: 'src/app.ts' }];

            // Mock API calls
            mockGitlabAPI.MergeRequests.allCommits.mockResolvedValue(commits);
            mockGitlabAPI.Repositories.compare.mockResolvedValue({
                diffs: compareDiffs,
            });
            mockGitlabAPI.MergeRequests.allDiffs.mockResolvedValue(mrDiffs);

            // Execute
            const result = await gitlabService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'project-123' },
                prNumber: 456,
                lastCommit: { sha: 'commit-a1' },
            });

            // Assert
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('src/app.ts');
            expect(result[0].status).toBe('modified');
            expect(result[0].additions).toBe(5);
            expect(result[0].deletions).toBe(2);
        });

        it('should NOT include files from branch B that came via merge of main', async () => {
            const commits = [
                { id: 'commit-a1', created_at: '2024-01-02T00:00:00Z' },
                { id: 'merge-main', created_at: '2024-01-06T00:00:00Z' },
            ];

            const compareDiffs = [
                { new_path: 'src/app.ts', diff: '@@ -1,1 +1,2 @@\n-old\n+new' },
                {
                    new_path: 'src/feature-b/component1.ts',
                    diff: '+// Component 1',
                    new_file: true,
                },
                {
                    new_path: 'src/feature-b/component2.ts',
                    diff: '+// Component 2',
                    new_file: true,
                },
                {
                    new_path: 'src/feature-b/component3.ts',
                    diff: '+// Component 3',
                    new_file: true,
                },
            ];

            const mrDiffs = [{ new_path: 'src/app.ts' }];

            mockGitlabAPI.MergeRequests.allCommits.mockResolvedValue(commits);
            mockGitlabAPI.Repositories.compare.mockResolvedValue({
                diffs: compareDiffs,
            });
            mockGitlabAPI.MergeRequests.allDiffs.mockResolvedValue(mrDiffs);

            const result = await gitlabService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'project-123' },
                prNumber: 456,
                lastCommit: { sha: 'commit-a1' },
            });

            const filenames = result.map((f: any) => f.filename);
            expect(filenames).not.toContain('src/feature-b/component1.ts');
            expect(filenames).not.toContain('src/feature-b/component2.ts');
            expect(filenames).not.toContain('src/feature-b/component3.ts');
        });

        it('should handle large merge with many files from main', async () => {
            const commits = [
                { id: 'commit-a1', created_at: '2024-01-02T00:00:00Z' },
                { id: 'merge-main', created_at: '2024-01-06T00:00:00Z' },
            ];

            // Simulate 2 real files + 20 from merge
            const compareDiffs = [
                { new_path: 'src/real-file-0.ts', diff: '+real change 0' },
                { new_path: 'src/real-file-1.ts', diff: '+real change 1' },
                ...Array.from({ length: 20 }, (_, i) => ({
                    new_path: `src/from-merge/file-${i}.ts`,
                    diff: `+merge content ${i}`,
                    new_file: true,
                })),
            ];

            const mrDiffs = [
                { new_path: 'src/real-file-0.ts' },
                { new_path: 'src/real-file-1.ts' },
            ];

            mockGitlabAPI.MergeRequests.allCommits.mockResolvedValue(commits);
            mockGitlabAPI.Repositories.compare.mockResolvedValue({
                diffs: compareDiffs,
            });
            mockGitlabAPI.MergeRequests.allDiffs.mockResolvedValue(mrDiffs);

            const result = await gitlabService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'project-123' },
                prNumber: 456,
                lastCommit: { sha: 'commit-a1' },
            });

            expect(result).toHaveLength(2);
            expect(
                result.every((f: any) =>
                    f.filename.startsWith('src/real-file'),
                ),
            ).toBe(true);
        });

        it('should return empty when all compare files are from merge (nothing to review)', async () => {
            const commits = [
                { id: 'commit-a1', created_at: '2024-01-02T00:00:00Z' },
                { id: 'merge-main', created_at: '2024-01-06T00:00:00Z' },
            ];

            const compareDiffs = [
                {
                    new_path: 'src/from-main.ts',
                    diff: '+from main',
                    new_file: true,
                },
            ];

            const mrDiffs: any[] = [];

            mockGitlabAPI.MergeRequests.allCommits.mockResolvedValue(commits);
            mockGitlabAPI.Repositories.compare.mockResolvedValue({
                diffs: compareDiffs,
            });
            mockGitlabAPI.MergeRequests.allDiffs.mockResolvedValue(mrDiffs);

            const result = await gitlabService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'project-123' },
                prNumber: 456,
                lastCommit: { sha: 'commit-a1' },
            });

            expect(result).toHaveLength(0);
        });
    });
});
