// Mock e2b — globally mapped via moduleNameMapper in jest.config.ts
// to avoid ESM parse errors from chalk v5+.
jest.mock('e2b', () => ({
    Sandbox: { create: jest.fn() },
}));

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

import { Test, TestingModule } from '@nestjs/testing';
import { CollectCrossFileContextStage } from '@libs/code-review/pipeline/stages/collect-cross-file-context.stage';
import { parseGitRemoteUrl } from '@libs/code-review/pipeline/services/clone-params-resolver.service';
import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsResult,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
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

    const mockGraphContextService = {
        parseAndGetGraphJson: jest.fn().mockResolvedValue(null),
    };

    const sandboxFromContext = {
        type: 'e2b' as const,
        sandboxId: 'lease-sandbox-id',
        repoDir: '/home/user/repo',
        baseBranch: 'main',
        cleanup: jest.fn().mockResolvedValue(undefined),
        remoteCommands: {
            grep: jest.fn(),
            read: jest.fn(),
            listDir: jest.fn(),
        },
        run: jest.fn(),
        readFile: jest.fn(),
        writeFile: jest.fn(),
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
                    provide: GraphContextService,
                    useValue: mockGraphContextService,
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
                sandboxHandle: sandboxFromContext as any,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should skip when no sandbox in context (lease manager owns lifecycle)', async () => {
            const context = createCrossFileBaseContext({
                sandboxHandle: undefined,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should skip in fast review mode', async () => {
            const context = createCrossFileBaseContext({
                sandboxHandle: sandboxFromContext as any,
                codeReviewConfig: {
                    reviewMode: 'fast',
                    reviewOptions: { cross_file: true },
                } as any,
            });

            const result = await stage.execute(context);

            expect(result.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });
    });

    // ─── Happy path ────────────────────────────────────────────────────────

    describe('happy path', () => {
        it('should reuse sandbox from context and collect cross-file contexts', async () => {
            const result: CollectCrossFileContextsResult = {
                contexts: [createSampleSnippet()],
                totalSearches: 1,
                totalSnippetsBeforeDedup: 1,
                plannerQueries: [],
            };
            mockCollectContexts.mockResolvedValue(result);

            const context = createCrossFileBaseContext({
                sandboxHandle: sandboxFromContext as any,
            });

            const out = await stage.execute(context);

            // Stage should NOT create a sandbox of its own — it consumes
            // the lease-managed sandbox already on the context.
            expect(mockCollectContexts).toHaveBeenCalledTimes(1);
            expect(mockCollectContexts).toHaveBeenCalledWith(
                expect.objectContaining({
                    remoteCommands: sandboxFromContext.remoteCommands,
                }),
            );
            expect(out.crossFileContexts).toEqual(result);
        });
    });

    // ─── Error handling ────────────────────────────────────────────────────

    describe('error handling', () => {
        it('should swallow collectContexts error and return context unchanged (non-fatal)', async () => {
            mockCollectContexts.mockRejectedValue(new Error('boom'));

            const context = createCrossFileBaseContext({
                sandboxHandle: sandboxFromContext as any,
            });

            const out = await stage.execute(context);

            expect(out.crossFileContexts).toBeUndefined();
            // Sandbox lifecycle is owned by the lease manager — stage MUST NOT
            // call cleanup() on the lease-managed sandbox.
            expect(sandboxFromContext.cleanup).not.toHaveBeenCalled();
        });
    });

    // ─── CLI mode ──────────────────────────────────────────────────────────

    describe('CLI mode guards', () => {
        it('should skip when isTrialMode is true', async () => {
            const context = createCliCrossFileBaseContext({
                isTrialMode: true,
                sandboxHandle: sandboxFromContext as any,
            } as any);

            const out = await stage.execute(context as any);

            expect(out.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });

        it('should skip when gitContext.remote is missing', async () => {
            const context = createCliCrossFileBaseContext({
                gitContext: { remote: '' } as any,
                sandboxHandle: sandboxFromContext as any,
            } as any);

            const out = await stage.execute(context as any);

            expect(out.crossFileContexts).toBeUndefined();
            expect(mockCollectContexts).not.toHaveBeenCalled();
        });
    });

    // ─── parseGitRemoteUrl ─────────────────────────────────────────────────

    describe('parseGitRemoteUrl()', () => {
        it('should parse HTTPS URLs with .git suffix', () => {
            const result = parseGitRemoteUrl(
                'https://github.com/owner/repo.git',
            );
            expect(result).toEqual({ fullName: 'owner/repo', name: 'repo' });
        });

        it('should parse HTTPS URLs without .git suffix', () => {
            const result = parseGitRemoteUrl('https://github.com/owner/repo');
            expect(result).toEqual({ fullName: 'owner/repo', name: 'repo' });
        });

        it('should parse SSH URLs', () => {
            const result = parseGitRemoteUrl('git@github.com:owner/repo.git');
            expect(result).toEqual({ fullName: 'owner/repo', name: 'repo' });
        });

        it('should parse SSH URLs without .git suffix', () => {
            const result = parseGitRemoteUrl('git@github.com:owner/repo');
            expect(result).toEqual({ fullName: 'owner/repo', name: 'repo' });
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
