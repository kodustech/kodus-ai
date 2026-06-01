import { Test, TestingModule } from '@nestjs/testing';
import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
import { KodusGraphCli } from '@libs/code-review/infrastructure/adapters/services/graph/kodus-graph-cli';
import { AstGraphRepository } from '@libs/code-review/infrastructure/adapters/repositories/astGraph.repository';
import { IRepositoryService, REPOSITORY_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('GraphContextService', () => {
    let service: GraphContextService;
    let mockAstGraphRepo: jest.Mocked<AstGraphRepository>;
    let mockRepositoryRepo: jest.Mocked<IRepositoryService>;
    let mockSandbox: jest.Mocked<SandboxInstance>;

    const REPO_ID = 'repo-456';

    const graphJson = JSON.stringify({
        nodes: [
            {
                kind: 'function',
                name: 'handleRequest',
                qualified_name: 'src/handler.ts::handleRequest',
                file_path: 'src/handler.ts',
                line_start: 5,
                line_end: 20,
                language: 'typescript',
                is_test: false,
            },
        ],
        edges: [
            {
                kind: 'calls',
                source_qualified: 'src/handler.ts::handleRequest',
                target_qualified: 'src/db.ts::query',
                file_path: 'src/handler.ts',
                line: 10,
            },
        ],
    });

    const promptContent =
        '## Code Graph Context\nFunction handleRequest calls query...';

    function createMockSandbox(
        overrides: Partial<SandboxInstance> = {},
    ): jest.Mocked<SandboxInstance> {
        return {
            remoteCommands: {
                grep: jest.fn(),
                read: jest.fn(),
                listDir: jest.fn(),
            },
            cleanup: jest.fn(),
            type: 'e2b' as const,
            repoDir: '/home/user/repo',
            run: jest
                .fn()
                .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
            readFile: jest.fn().mockResolvedValue(promptContent),
            writeFile: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        } as jest.Mocked<SandboxInstance>;
    }

    function createChangedFiles(
        filenames: string[],
        opts?: { withPatch?: boolean },
    ): FileChange[] {
        return filenames.map(
            (filename) =>
                ({
                    filename,
                    status: 'modified' as const,
                    sha: 'abc123',
                    content: null,
                    additions: 5,
                    deletions: 2,
                    changes: 7,
                    blob_url: '',
                    raw_url: '',
                    contents_url: '',
                    patch: opts?.withPatch
                        ? `@@ -1,5 +1,7 @@\n+new line`
                        : undefined,
                }) as FileChange,
        );
    }

    beforeEach(async () => {
        mockAstGraphRepo = {
            exportSubgraphJsonString: jest
                .fn()
                .mockResolvedValue('{"nodes":[],"edges":[]}'),
        } as any;

        mockRepositoryRepo = {
            findById: jest.fn().mockResolvedValue({
                uuid: REPO_ID,
                name: 'test-repo',
                astGraphSha: 'sha-main',
            }),
        } as any;

        mockSandbox = createMockSandbox();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GraphContextService,
                KodusGraphCli,
                { provide: AstGraphRepository, useValue: mockAstGraphRepo },
                { provide: REPOSITORY_SERVICE_TOKEN, useValue: mockRepositoryRepo },
            ],
        }).compile();

        service = module.get<GraphContextService>(GraphContextService);
    });

    describe('generateContext', () => {
        it('should return empty string when sandbox has no run method', async () => {
            const noRunSandbox = { type: 'null' } as any;

            const result = await service.generateContext(
                noRunSandbox,
                createChangedFiles(['src/handler.ts']),
                REPO_ID,
            );

            expect(result).toBe('');
        });

        it('should return empty string when no file paths extracted', async () => {
            const emptyFiles: FileChange[] = [
                {
                    filename: '',
                    status: 'modified',
                    sha: '',
                    content: null,
                    additions: 0,
                    deletions: 0,
                    changes: 0,
                    blob_url: '',
                    raw_url: '',
                    contents_url: '',
                },
            ] as FileChange[];

            const result = await service.generateContext(
                mockSandbox,
                emptyFiles,
                REPO_ID,
            );

            expect(result).toBe('');
        });

        it('should install, parse files, export subgraph, and produce a prompt', async () => {
            const changedFiles = createChangedFiles(['src/handler.ts'], {
                withPatch: true,
            });

            const result = await service.generateContext(
                mockSandbox,
                changedFiles,
                REPO_ID,
            );

            expect(mockSandbox.run).toHaveBeenCalled();
            expect(mockSandbox.writeFile).toHaveBeenCalled();
            expect(mockSandbox.readFile).toHaveBeenCalled();
            expect(result).toBe(promptContent);
        });

        it('should fall back to generateContextLegacy when repo not found in DB', async () => {
            mockRepositoryRepo.findById.mockResolvedValue(null);
            const changedFiles = createChangedFiles(['src/handler.ts'], {
                withPatch: true,
            });

            const result = await service.generateContext(
                mockSandbox,
                changedFiles,
                REPO_ID,
            );

            expect(result).toBeDefined();
            expect(mockRepositoryRepo.findById).toHaveBeenCalledWith(REPO_ID);
            expect(
                mockAstGraphRepo.exportSubgraphJsonString,
            ).not.toHaveBeenCalled();
        });

        it('should fall back to generateContextLegacy on error', async () => {
            mockAstGraphRepo.exportSubgraphJsonString.mockRejectedValue(
                new Error('DB connection lost'),
            );
            const changedFiles = createChangedFiles(['src/handler.ts'], {
                withPatch: true,
            });

            const result = await service.generateContext(
                mockSandbox,
                changedFiles,
                REPO_ID,
            );

            expect(result).toBeDefined();
        });
    });

    describe('generateContextLegacy', () => {
        it('should return empty string when sandbox has no run method', async () => {
            const noRunSandbox = { type: 'null' } as any;
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.generateContextLegacy(
                noRunSandbox,
                changedFiles,
            );

            expect(result).toBe('');
        });

        it('should return empty string when no file paths extracted', async () => {
            const emptyFiles: FileChange[] = [
                {
                    filename: '',
                    status: 'modified',
                    sha: '',
                    content: null,
                    additions: 0,
                    deletions: 0,
                    changes: 0,
                    blob_url: '',
                    raw_url: '',
                    contents_url: '',
                },
            ] as FileChange[];

            const result = await service.generateContextLegacy(
                mockSandbox,
                emptyFiles,
            );

            expect(result).toBe('');
            expect(mockSandbox.run).not.toHaveBeenCalled();
        });

        it('should install kodus-graph, write diff, and generate prompt', async () => {
            const changedFiles = createChangedFiles(
                ['src/handler.ts', 'src/db.ts'],
                { withPatch: true },
            );

            const result = await service.generateContextLegacy(
                mockSandbox,
                changedFiles,
            );

            expect(mockSandbox.run).toHaveBeenCalled();
            expect(mockSandbox.writeFile).toHaveBeenCalled();
            expect(mockSandbox.readFile).toHaveBeenCalled();
            expect(result).toBe(promptContent);
        });

        it('should return empty string on failure (non-blocking)', async () => {
            mockSandbox.run.mockRejectedValue(new Error('sandbox crashed'));
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.generateContextLegacy(
                mockSandbox,
                changedFiles,
            );

            expect(result).toBe('');
        });

        it('should pass baseBranch to buildBaseGraphFromGit when provided', async () => {
            const changedFiles = createChangedFiles(['src/handler.ts'], {
                withPatch: true,
            });

            await service.generateContextLegacy(
                mockSandbox,
                changedFiles,
                'main',
            );

            const allRunCalls = mockSandbox.run.mock.calls.map(
                (call) => call[0] as string,
            );
            const hasGitShowCall = allRunCalls.some(
                (cmd) =>
                    cmd.includes('git show') && cmd.includes('origin/main'),
            );
            expect(hasGitShowCall).toBe(true);
        });
    });

    describe('parseAndGetGraphJson', () => {
        it('should return null when sandbox has no run method', async () => {
            const noRunSandbox = { type: 'null' } as any;
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                noRunSandbox,
                changedFiles,
            );

            expect(result).toBeNull();
        });

        it('should return null when no file paths', async () => {
            const emptyFiles: FileChange[] = [
                {
                    filename: '',
                    status: 'modified',
                    sha: '',
                    content: null,
                    additions: 0,
                    deletions: 0,
                    changes: 0,
                    blob_url: '',
                    raw_url: '',
                    contents_url: '',
                },
            ] as FileChange[];

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                emptyFiles,
            );

            expect(result).toBeNull();
        });

        it('should install, parse files, and read graph JSON via sandbox.readFile()', async () => {
            mockSandbox.readFile.mockResolvedValue(graphJson);
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                changedFiles,
            );

            expect(mockSandbox.run).toHaveBeenCalled();
            expect(mockSandbox.readFile).toHaveBeenCalledWith(
                expect.stringContaining('graph.json'),
                expect.any(Object),
            );

            expect(result).toEqual({
                nodes: expect.arrayContaining([
                    expect.objectContaining({ name: 'handleRequest' }),
                ]),
                edges: expect.arrayContaining([
                    expect.objectContaining({ kind: 'calls' }),
                ]),
            });
        });

        it('should return { nodes, edges } on success', async () => {
            mockSandbox.readFile.mockResolvedValue(graphJson);
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                changedFiles,
            );

            expect(result).not.toBeNull();
            expect(result!.nodes).toHaveLength(1);
            expect(result!.edges).toHaveLength(1);
        });

        it('should return null when graph has 0 nodes', async () => {
            mockSandbox.readFile.mockResolvedValue(
                JSON.stringify({ nodes: [], edges: [] }),
            );
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                changedFiles,
            );

            expect(result).toBeNull();
        });

        it('should return null on failure', async () => {
            mockSandbox.readFile.mockRejectedValue(
                new Error('File not found'),
            );
            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                changedFiles,
            );

            expect(result).toBeNull();
        });

        it('should return null on parse command failure', async () => {
            // which-check + install succeed, parse fails
            mockSandbox.run
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({
                    stdout: '',
                    stderr: 'parse error',
                    exitCode: 1,
                });

            const changedFiles = createChangedFiles(['src/handler.ts']);

            const result = await service.parseAndGetGraphJson(
                mockSandbox,
                changedFiles,
            );

            expect(result).toBeNull();
        });
    });
});
