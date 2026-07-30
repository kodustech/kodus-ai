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
let GithubService: any;

describe('GitHub getChangedFilesSinceLastCommit - integration tests for merge commit filtering', () => {
    let githubService: any;
    let mockOctokit: any;

    beforeAll(async () => {
        // Import GithubService dinamicamente
        const module =
            await import('@libs/platform/infrastructure/adapters/services/github/github.service');
        GithubService = (module as any).default || module.GithubService;
    });

    beforeEach(async () => {
        // Setup mock Octokit
        mockOctokit = {
            paginate: jest.fn(),
            pulls: {
                listCommits: jest.fn(),
                listFiles: jest.fn(),
            },
            repos: {
                compareCommitsWithBasehead: jest.fn(),
            },
        };

        // Create test module
        const moduleRef = await Test.createTestingModule({
            providers: [
                GithubService,
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

        githubService = moduleRef.get(GithubService);

        // Mock internal methods
        jest.spyOn(githubService, 'getGithubAuthDetails').mockResolvedValue({
            org: 'test-org',
            token: 'test-token',
        });

        jest.spyOn(githubService, 'instanceOctokit').mockResolvedValue(
            mockOctokit,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('should exclude files that came from merge commits', () => {
        it('should return only 1 file (the one actually changed on branch A)', async () => {
            // Setup: Branch A commits
            const commits = [
                {
                    sha: 'commit-a1',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'commit-a2',
                    commit: { author: { date: '2024-01-05T00:00:00Z' } },
                },
                {
                    sha: 'merge-main',
                    commit: { author: { date: '2024-01-06T00:00:00Z' } },
                },
            ];

            // Compare returns 4 files: 1 real change + 3 from merge
            const compareFiles = [
                {
                    filename: 'src/app.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    changes: 7,
                    patch: '@@ -10,2 +10,5 @@\n-    old\n+    new',
                },
                {
                    filename: 'src/feature-b/component1.ts',
                    status: 'added',
                    additions: 50,
                    deletions: 0,
                    changes: 50,
                    patch: '+// Component 1',
                },
                {
                    filename: 'src/feature-b/component2.ts',
                    status: 'added',
                    additions: 30,
                    deletions: 0,
                    changes: 30,
                    patch: '+// Component 2',
                },
                {
                    filename: 'src/feature-b/component3.ts',
                    status: 'added',
                    additions: 40,
                    deletions: 0,
                    changes: 40,
                    patch: '+// Component 3',
                },
            ];

            // PR files list only includes the real change
            const prFiles = [{ filename: 'src/app.ts' }];

            // Mock API calls
            mockOctokit.paginate
                .mockResolvedValueOnce(commits) // pulls.listCommits
                .mockResolvedValueOnce(prFiles); // pulls.listFiles

            mockOctokit.repos.compareCommitsWithBasehead.mockResolvedValue({
                data: { files: compareFiles },
            });

            // Execute
            const result = await githubService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { name: 'test-repo' },
                prNumber: 123,
                lastCommit: { sha: 'commit-a1' },
            });

            // Assert
            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('src/app.ts');
            expect(result[0].status).toBe('modified');
            expect(result[0].additions).toBe(5);
        });

        it('should NOT include files from branch B that came via merge of main', async () => {
            const commits = [
                {
                    sha: 'commit-a1',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'merge-main',
                    commit: { author: { date: '2024-01-06T00:00:00Z' } },
                },
            ];

            const compareFiles = [
                {
                    filename: 'src/app.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    changes: 7,
                    patch: '+new',
                },
                {
                    filename: 'src/feature-b/component1.ts',
                    status: 'added',
                    additions: 50,
                    deletions: 0,
                    changes: 50,
                    patch: '+comp1',
                },
                {
                    filename: 'src/feature-b/component2.ts',
                    status: 'added',
                    additions: 30,
                    deletions: 0,
                    changes: 30,
                    patch: '+comp2',
                },
                {
                    filename: 'src/feature-b/component3.ts',
                    status: 'added',
                    additions: 40,
                    deletions: 0,
                    changes: 40,
                    patch: '+comp3',
                },
            ];

            const prFiles = [{ filename: 'src/app.ts' }];

            mockOctokit.paginate
                .mockResolvedValueOnce(commits)
                .mockResolvedValueOnce(prFiles);

            mockOctokit.repos.compareCommitsWithBasehead.mockResolvedValue({
                data: { files: compareFiles },
            });

            const result = await githubService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { name: 'test-repo' },
                prNumber: 123,
                lastCommit: { sha: 'commit-a1' },
            });

            const filenames = result.map((f: any) => f.filename);
            expect(filenames).not.toContain('src/feature-b/component1.ts');
            expect(filenames).not.toContain('src/feature-b/component2.ts');
            expect(filenames).not.toContain('src/feature-b/component3.ts');
        });

        it('should handle large merge with many files from main', async () => {
            const commits = [
                {
                    sha: 'commit-a1',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'merge-main',
                    commit: { author: { date: '2024-01-06T00:00:00Z' } },
                },
            ];

            // Simulate 2 real files + 20 from merge
            const compareFiles = [
                {
                    filename: 'src/real-file-0.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    changes: 7,
                    patch: '+real',
                },
                {
                    filename: 'src/real-file-1.ts',
                    status: 'modified',
                    additions: 3,
                    deletions: 1,
                    changes: 4,
                    patch: '+real',
                },
                ...Array.from({ length: 20 }, (_, i) => ({
                    filename: `src/from-merge/file-${i}.ts`,
                    status: 'added',
                    additions: 50,
                    deletions: 0,
                    changes: 50,
                    patch: `+merge ${i}`,
                })),
            ];

            const prFiles = [
                { filename: 'src/real-file-0.ts' },
                { filename: 'src/real-file-1.ts' },
            ];

            mockOctokit.paginate
                .mockResolvedValueOnce(commits)
                .mockResolvedValueOnce(prFiles);

            mockOctokit.repos.compareCommitsWithBasehead.mockResolvedValue({
                data: { files: compareFiles },
            });

            const result = await githubService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { name: 'test-repo' },
                prNumber: 123,
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
                {
                    sha: 'commit-a1',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'merge-main',
                    commit: { author: { date: '2024-01-06T00:00:00Z' } },
                },
            ];

            const compareFiles = [
                {
                    filename: 'src/from-main.ts',
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    changes: 10,
                    patch: '+from main',
                },
            ];

            const prFiles: any[] = [];

            mockOctokit.paginate
                .mockResolvedValueOnce(commits)
                .mockResolvedValueOnce(prFiles);

            mockOctokit.repos.compareCommitsWithBasehead.mockResolvedValue({
                data: { files: compareFiles },
            });

            const result = await githubService.getChangedFilesSinceLastCommit({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { name: 'test-repo' },
                prNumber: 123,
                lastCommit: { sha: 'commit-a1' },
            });

            expect(result).toHaveLength(0);
        });
    });
});
