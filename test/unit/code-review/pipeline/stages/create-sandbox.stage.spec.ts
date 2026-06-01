import { Test, TestingModule } from '@nestjs/testing';
import { CloneParamsResolverService } from '@libs/code-review/pipeline/services/clone-params-resolver.service';
import { CreateSandboxStage } from '@/code-review/pipeline/stages/create-sandbox.stage';
import {
    ISandboxLeaseManager,
    SANDBOX_LEASE_MANAGER_TOKEN,
    AcquireResult,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { NULL_SANDBOX_INSTANCE } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import { CodeManagementService } from '@/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CreateSandboxStage', () => {
    let stage: CreateSandboxStage;
    let mockLeaseManager: jest.Mocked<ISandboxLeaseManager>;
    let mockCodeManagementService: jest.Mocked<CodeManagementService>;

    let mockCloneParamsResolver: any;

    const makeMockAcquireResult = (): AcquireResult => ({
        sandbox: {
            ...NULL_SANDBOX_INSTANCE,
            type: 'e2b',
            repoDir: '/home/user/repo',
            cleanup: jest.fn().mockResolvedValue(undefined),
            remoteCommands: {
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            },
            run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
            readFile: jest.fn().mockResolvedValue(''),
            writeFile: jest.fn().mockResolvedValue(undefined),
        },
        leaseId: 'test-lease-id',
        sandboxId: 'test-sandbox-id',
        wasCreated: true,
    });

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            dryRun: { enabled: false },
            organizationAndTeamData: {
                organizationId: '7e2e97b8-aefa-422e-92d4-30b378c0332e',
                teamId: 'team-456',
            } as any,
            repository: {
                id: 'repo-1',
                name: 'test-repo',
                fullName: 'org/test-repo',
                defaultBranch: 'main',
            } as any,
            branch: 'feature-branch',
            pullRequest: {
                number: 42,
                title: 'Test PR',
                base: { repo: { fullName: 'org/repo' }, ref: 'main' },
                repository: {} as any,
                isDraft: false,
                stats: {
                    total_additions: 10,
                    total_deletions: 5,
                    total_files: 2,
                    total_lines_changed: 15,
                },
            },
            teamAutomationId: 'team-auto-1',
            origin: 'github',
            action: 'opened',
            platformType: PlatformType.GITHUB,
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            correlationId: 'test-correlation-id',
            ...overrides,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockLeaseManager = {
            acquire: jest.fn().mockResolvedValue(makeMockAcquireResult()),
            release: jest.fn().mockResolvedValue(undefined),
            invalidate: jest.fn().mockResolvedValue(undefined),
        };

        mockCodeManagementService = {
            getCloneParams: jest.fn().mockResolvedValue({
                url: 'https://github.com/org/test-repo.git',
                auth: { token: 'ghp_test_token' },
            }),
        } as any;

        mockCloneParamsResolver = {
            resolve: jest.fn().mockResolvedValue({
                url: 'https://github.com/org/test-repo.git',
                authToken: 'ghp_test_token',
                branch: 'feature-branch',
                prNumber: 42,
                platform: PlatformType.GITHUB,
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateSandboxStage,
                {
                    provide: SANDBOX_LEASE_MANAGER_TOKEN,
                    useValue: mockLeaseManager,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: CloneParamsResolverService,
                    useValue: mockCloneParamsResolver,
                },
            ],
        }).compile();

        stage = module.get<CreateSandboxStage>(CreateSandboxStage);
    });

    it('should have correct stage name', () => {
        expect(stage.stageName).toBe('CreateSandboxStage');
    });

    describe('guard conditions', () => {
        it('should skip if sandbox already exists in context', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
                sandboxHandle: {
                    type: 'e2b' as const,
                    sandboxId: 'mock-sandbox-id',
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    repoDir: '/home/user/repo',
                    run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
                    readFile: jest.fn().mockResolvedValue(''),
                    writeFile: jest.fn().mockResolvedValue(undefined),
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(mockLeaseManager.acquire).not.toHaveBeenCalled();
            expect(result.sandboxHandle).toBeDefined();
        });

        it('should skip if no changed files', async () => {
            const context = createBaseContext({ changedFiles: [] });

            const _result = await (stage as any).executeStage(context);

            expect(mockLeaseManager.acquire).not.toHaveBeenCalled();
        });

        it('should proceed and acquire lease even when sandbox provider type is null', async () => {
            // With the lease manager, availability is no longer a guard in the stage.
            // The manager returns a null sandbox when E2B is not configured.
            const nullAcquireResult: AcquireResult = {
                sandbox: { ...NULL_SANDBOX_INSTANCE, cleanup: jest.fn().mockResolvedValue(undefined) },
                leaseId: 'null-lease-id',
                sandboxId: '',
                wasCreated: true,
            };
            mockLeaseManager.acquire.mockResolvedValue(nullAcquireResult);

            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            expect(mockLeaseManager.acquire).toHaveBeenCalledWith(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo-1:42',
                'review',
                undefined,
                expect.objectContaining({
                    cloneUrl: 'https://github.com/org/test-repo.git',
                    platform: 'GITHUB',
                    branch: 'feature-branch',
                    prNumber: 42,
                    sandboxMetadata: { stage: 'review' },
                }),
            );
            // Null sandbox is stored in context — review runs in self-contained mode
            expect(result.sandboxHandle).toBeDefined();
            expect(result.sandboxHandle.type).toBe('null');
        });
    });

    describe('sandbox creation', () => {
        it('should acquire lease and store sandbox in context', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            expect(mockLeaseManager.acquire).toHaveBeenCalledWith(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo-1:42',
                'review',
                undefined,
                expect.objectContaining({
                    cloneUrl: 'https://github.com/org/test-repo.git',
                    platform: 'GITHUB',
                    branch: 'feature-branch',
                    prNumber: 42,
                    sandboxMetadata: { stage: 'review' },
                }),
            );

            expect(result.sandboxHandle).toBeDefined();
            expect(result.sandboxHandle.remoteCommands).toBeDefined();
            expect(result.getFreshCloneParams).toBeDefined();

            const freshParams = await result.getFreshCloneParams!();
            expect(freshParams.cloneUrl).toBe(
                'https://github.com/org/test-repo.git',
            );
        });

        it('cleanup closure calls leaseManager.release with correct leaseId', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.sandboxHandle).toBeDefined();
            // Invoke cleanup — should call release, not kill
            await result.sandboxHandle.cleanup();
            // Review flow shrinks the idle window to 30s (REVIEW_IDLE_TIMEOUT_MS)
            // so the sandbox pauses fast when no @kody arrives.
            expect(mockLeaseManager.release).toHaveBeenCalledWith(
                'test-lease-id',
                { idleMs: 30_000 },
            );
        });

        it('should handle lease acquisition failure gracefully', async () => {
            mockLeaseManager.acquire.mockRejectedValue(
                new Error('Lease acquisition timeout'),
            );

            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            // Should NOT throw
            const result = await (stage as any).executeStage(context);

            expect(result.sandboxHandle).toBeUndefined();
        });

        it('does not retry acquire itself — retry+backoff lives inside the lease manager', async () => {
            // The stage used to retry once on failure; that responsibility moved
            // to SandboxLeaseManager.createWithRetry (3 attempts, 60s/120s backoff).
            // The stage now makes a single acquire() call and falls back to a
            // null context if it throws.
            mockLeaseManager.acquire.mockRejectedValue(
                new Error('Network timeout'),
            );

            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            expect(mockLeaseManager.acquire).toHaveBeenCalledTimes(1);
            expect(result.sandboxHandle).toBeUndefined();
        });
    });
});
