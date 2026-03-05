// Mock e2b — globally mapped via moduleNameMapper in jest.config.ts
// to avoid ESM parse errors from chalk v5+.
jest.mock('e2b', () => ({
    Sandbox: { create: jest.fn() },
}));

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { Test, TestingModule } from '@nestjs/testing';
import {
    CollectCrossFileContextStage,
    parseGitRemoteUrl,
} from '@libs/code-review/pipeline/stages/collect-cross-file-context.stage';
import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsResult,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { E2BSandboxService } from '@libs/code-review/infrastructure/adapters/services/e2bSandbox.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    createCrossFileBaseContext,
    createCliCrossFileBaseContext,
    createSampleSnippet,
} from '../../../../fixtures/cross-file-context.fixtures';

describe('CollectCrossFileContextStage', () => {
    let stage: CollectCrossFileContextStage;

    const mockCollectContexts = jest.fn();
    const mockCollectCrossFileContextsService = {
        collectContexts: mockCollectContexts,
    };

    const mockE2bSandboxService = {
        isAvailable: jest.fn(),
        createSandboxWithRepo: jest.fn(),
    };

    const mockCodeManagementService = {
        getCloneParams: jest.fn(),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CollectCrossFileContextStage,
                {
                    provide: COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
                    useValue: mockCollectCrossFileContextsService,
                },
                {
                    provide: E2BSandboxService,
                    useValue: mockE2bSandboxService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        stage = module.get<CollectCrossFileContextStage>(
            CollectCrossFileContextStage,
        );
        jest.clearAllMocks();
    });

    // ─── Guards ────────────────────────────────────────────────────────────

    describe('guards', () => {
        it('should return context unchanged when cross_file is disabled', async () => {
            const context = createCrossFileBaseContext({
                codeReviewConfig: {
                    reviewOptions: { cross_file: false },
                } as any,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should return context unchanged when changedFiles is empty', async () => {
            const context = createCrossFileBaseContext({
                changedFiles: [],
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should return context unchanged when E2B is not available', async () => {
            const context = createCrossFileBaseContext();
            mockE2bSandboxService.isAvailable.mockReturnValue(false);

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });
    });

    // ─── Happy Path ────────────────────────────────────────────────────────

    describe('happy path', () => {
        const setupHappyPath = () => {
            const mockCleanup = jest.fn().mockResolvedValue(undefined);
            const mockRemoteCommands = {
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            };

            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: mockRemoteCommands,
                cleanup: mockCleanup,
            });

            const collectResult: CollectCrossFileContextsResult = {
                contexts: [createSampleSnippet()],
                plannerQueries: [
                    {
                        symbolName: 'greet',
                        pattern: 'greet\\(',
                        rationale: 'test',
                        riskLevel: 'high',
                        fileGlob: '**/*.ts',
                    },
                ],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 2,
            };
            mockCollectContexts.mockResolvedValue(collectResult);

            return { mockCleanup, collectResult };
        };

        it('should execute full flow: getCloneParams → createSandbox → collectContexts → context updated', async () => {
            const { collectResult } = setupHappyPath();
            const context = createCrossFileBaseContext();

            const result = await stage.execute(context);

            expect(mockCodeManagementService.getCloneParams).toHaveBeenCalled();
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).toHaveBeenCalled();
            expect(mockCollectContexts).toHaveBeenCalled();
            expect(result.crossFileContexts).toEqual(collectResult);
        });

        it('should store sandboxHandle in context for safeguard agent (cleanup deferred)', async () => {
            const { mockCleanup } = setupHappyPath();
            const context = createCrossFileBaseContext();

            const result = await stage.execute(context);

            // Cleanup is no longer called in the stage — sandbox is kept alive
            // for safeguard agent verification in ProcessFilesReview
            expect(mockCleanup).not.toHaveBeenCalled();
            expect(result.sandboxHandle).toBeDefined();
            expect(result.sandboxHandle.cleanup).toBe(mockCleanup);
        });
    });

    // ─── Error Handling ────────────────────────────────────────────────────

    describe('error handling', () => {
        const setupWithError = () => {
            const mockCleanup = jest.fn().mockResolvedValue(undefined);

            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: mockCleanup,
            });

            return { mockCleanup };
        };

        it('should return context unchanged on collectContexts error (non-fatal)', async () => {
            const { mockCleanup } = setupWithError();
            mockCollectContexts.mockRejectedValue(
                new Error('collectContexts failed'),
            );

            const context = createCrossFileBaseContext();
            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCleanup).toHaveBeenCalled();
        });

        it('should swallow cleanup failure and return context unchanged', async () => {
            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });

            const failingCleanup = jest
                .fn()
                .mockRejectedValue(new Error('cleanup exploded'));
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: failingCleanup,
            });
            mockCollectContexts.mockRejectedValue(new Error('some error'));

            const context = createCrossFileBaseContext();

            // Cleanup failure is now caught and logged as a warning
            // (sandbox is kept alive for safeguard agent verification on success,
            //  and cleaned up in catch block on error with try/catch protection)
            const result = await stage.execute(context);
            expect(result.crossFileContexts).toBeUndefined();
            expect(failingCleanup).toHaveBeenCalled();
        });
    });

    // ─── CLI Mode Guards ────────────────────────────────────────────────────

    describe('CLI mode guards', () => {
        it('should skip when isTrialMode is true', async () => {
            const context = createCliCrossFileBaseContext({
                isTrialMode: true,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockE2bSandboxService.isAvailable).not.toHaveBeenCalled();
        });

        it('should skip when isFastMode is true', async () => {
            const context = createCliCrossFileBaseContext({
                isFastMode: true,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockE2bSandboxService.isAvailable).not.toHaveBeenCalled();
        });

        it('should skip when gitContext.remote is missing', async () => {
            const context = createCliCrossFileBaseContext({
                gitContext: { branch: 'main' },
            });
            mockE2bSandboxService.isAvailable.mockReturnValue(true);

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).not.toHaveBeenCalled();
        });

        it('should NOT skip trial/fast guards for PR mode (origin !== cli)', async () => {
            // PR context with origin=github should NOT be affected by CLI guards
            const context = createCrossFileBaseContext();
            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/repo.git',
                auth: { token: 'test-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: jest.fn().mockResolvedValue(undefined),
            });
            mockCollectContexts.mockResolvedValue({
                contexts: [createSampleSnippet()],
                plannerQueries: [],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 1,
            });

            const result = await stage.execute(context);

            // PR mode should still execute the full flow
            expect(mockCollectContexts).toHaveBeenCalled();
            expect(result.crossFileContexts).toBeDefined();
        });
    });

    // ─── CLI Mode Happy Path ────────────────────────────────────────────────

    describe('CLI mode happy path', () => {
        const setupCliHappyPath = () => {
            const mockCleanup = jest.fn().mockResolvedValue(undefined);
            const mockRemoteCommands = {
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            };

            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockResolvedValue({
                url: 'https://github.com/org/test-repo.git',
                auth: { token: 'integration-token' },
            });
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: mockRemoteCommands,
                cleanup: mockCleanup,
            });

            const collectResult: CollectCrossFileContextsResult = {
                contexts: [createSampleSnippet()],
                plannerQueries: [],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 2,
            };
            mockCollectContexts.mockResolvedValue(collectResult);

            return { mockCleanup, collectResult };
        };

        it('should resolve clone params from gitContext and collect cross-file contexts', async () => {
            const { collectResult } = setupCliHappyPath();
            const context = createCliCrossFileBaseContext();

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toEqual(collectResult);
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    cloneUrl: 'https://github.com/org/test-repo.git',
                    branch: 'feat/cli-test',
                    prNumber: undefined,
                    platform: PlatformType.GITHUB,
                }),
            );
        });
    });

    // ─── CLI Mode Auth Fallback ─────────────────────────────────────────────

    describe('CLI mode auth fallback', () => {
        it('should continue with empty auth token when getCloneParams fails', async () => {
            mockE2bSandboxService.isAvailable.mockReturnValue(true);
            mockCodeManagementService.getCloneParams.mockRejectedValue(
                new Error('No integration configured'),
            );
            const mockCleanup = jest.fn().mockResolvedValue(undefined);
            mockE2bSandboxService.createSandboxWithRepo.mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: mockCleanup,
            });
            mockCollectContexts.mockResolvedValue({
                contexts: [createSampleSnippet()],
                plannerQueries: [],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 1,
            });

            const context = createCliCrossFileBaseContext();
            const result = await stage.execute(context);

            // Should still try to create sandbox with empty auth
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    authToken: '',
                }),
            );
            expect(result.crossFileContexts).toBeDefined();
        });

        it('should return context unchanged when git remote URL cannot be parsed', async () => {
            mockE2bSandboxService.isAvailable.mockReturnValue(true);

            const context = createCliCrossFileBaseContext({
                gitContext: {
                    remote: 'not-a-valid-url',
                    branch: 'main',
                },
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(
                mockE2bSandboxService.createSandboxWithRepo,
            ).not.toHaveBeenCalled();
        });
    });

    // ─── parseGitRemoteUrl ──────────────────────────────────────────────────

    describe('parseGitRemoteUrl()', () => {
        it('should parse HTTPS URLs with .git suffix', () => {
            const result = parseGitRemoteUrl(
                'https://github.com/owner/repo.git',
            );
            expect(result).toEqual({
                fullName: 'owner/repo',
                name: 'repo',
            });
        });

        it('should parse HTTPS URLs without .git suffix', () => {
            const result = parseGitRemoteUrl('https://github.com/owner/repo');
            expect(result).toEqual({
                fullName: 'owner/repo',
                name: 'repo',
            });
        });

        it('should parse SSH URLs', () => {
            const result = parseGitRemoteUrl('git@github.com:owner/repo.git');
            expect(result).toEqual({
                fullName: 'owner/repo',
                name: 'repo',
            });
        });

        it('should parse SSH URLs without .git suffix', () => {
            const result = parseGitRemoteUrl('git@github.com:owner/repo');
            expect(result).toEqual({
                fullName: 'owner/repo',
                name: 'repo',
            });
        });

        it('should parse GitLab SSH URLs', () => {
            const result = parseGitRemoteUrl(
                'git@gitlab.com:my-org/my-repo.git',
            );
            expect(result).toEqual({
                fullName: 'my-org/my-repo',
                name: 'my-repo',
            });
        });

        it('should return null for invalid URLs', () => {
            expect(parseGitRemoteUrl('not-a-url')).toBeNull();
            expect(parseGitRemoteUrl('')).toBeNull();
        });
    });
});
