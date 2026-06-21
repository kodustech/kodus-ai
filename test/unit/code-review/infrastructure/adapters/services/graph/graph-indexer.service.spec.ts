import { Test, TestingModule } from '@nestjs/testing';
import { GraphIndexerService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-indexer.service';
import { KodusGraphCli } from '@libs/code-review/infrastructure/adapters/services/graph/kodus-graph-cli';
import { AstGraphRepository } from '@libs/code-review/infrastructure/adapters/repositories/astGraph.repository';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('GraphIndexerService', () => {
    let service: GraphIndexerService;
    let mockAstGraphRepo: jest.Mocked<AstGraphRepository>;
    let mockRepositoryRepo: jest.Mocked<IRepositoryService>;
    let mockSandbox: jest.Mocked<SandboxInstance>;

    const REPO_ID = 'repo-123';
    const HEAD_SHA = 'abc123def456';

    const graphJson = JSON.stringify({
        nodes: [
            {
                kind: 'function',
                name: 'foo',
                qualified_name: 'src/foo.ts::foo',
                file_path: 'src/foo.ts',
                line_start: 1,
                line_end: 10,
                language: 'typescript',
                is_test: false,
            },
        ],
        edges: [
            {
                kind: 'calls',
                source_qualified: 'src/foo.ts::foo',
                target_qualified: 'src/bar.ts::bar',
                file_path: 'src/foo.ts',
                line: 5,
            },
        ],
    });

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
            readFile: jest.fn().mockResolvedValue(graphJson),
            writeFile: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        } as jest.Mocked<SandboxInstance>;
    }

    /** Returns the string command of the nth sandbox.run call (0-indexed). */
    const runCmd = (sandbox: jest.Mocked<SandboxInstance>, i: number) =>
        sandbox.run.mock.calls[i][0] as string;

    /** Returns the index of the first run call whose command matches the predicate. */
    const findRunIndex = (
        sandbox: jest.Mocked<SandboxInstance>,
        predicate: (cmd: string) => boolean,
    ) =>
        sandbox.run.mock.calls.findIndex((call) =>
            predicate(call[0] as string),
        );

    beforeEach(async () => {
        mockAstGraphRepo = {
            fullRebuild: jest
                .fn()
                .mockResolvedValue({ nodeCount: 1, edgeCount: 1 }),
            incrementalUpdate: jest
                .fn()
                .mockResolvedValue({ nodeCount: 1, edgeCount: 1 }),
        } as any;

        mockRepositoryRepo = {
            updateGraphStatus: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockSandbox = createMockSandbox();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GraphIndexerService,
                KodusGraphCli,
                { provide: AstGraphRepository, useValue: mockAstGraphRepo },
                {
                    provide: REPOSITORY_SERVICE_TOKEN,
                    useValue: mockRepositoryRepo,
                },
            ],
        }).compile();

        service = module.get<GraphIndexerService>(GraphIndexerService);
    });

    describe('fullBuild', () => {
        it('should install kodus-graph then parse the repo', async () => {
            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            // install() does: which-check → install → then parse --all
            const installIdx = findRunIndex(mockSandbox, (cmd) =>
                cmd.includes('bun install'),
            );
            const parseIdx = findRunIndex(mockSandbox, (cmd) =>
                cmd.includes('kodus-graph parse --all'),
            );

            expect(installIdx).toBeGreaterThanOrEqual(0);
            expect(parseIdx).toBeGreaterThan(installIdx);
            expect(runCmd(mockSandbox, installIdx)).toContain('kodus-graph');
        });

        it('should find preinstalled kodus-graph through the Bun global bin path', async () => {
            mockSandbox.run
                .mockResolvedValueOnce({
                    stdout: '/home/node/.bun/bin/kodus-graph\n0.2.19',
                    stderr: '',
                    exitCode: 0,
                })
                .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            const checkCmd = runCmd(mockSandbox, 0);
            expect(checkCmd).toContain('export PATH="$HOME/.bun/bin:$PATH"');
            expect(checkCmd).toContain('which kodus-graph');
            expect(
                mockSandbox.run.mock.calls.some((call) =>
                    (call[0] as string).includes('bun install'),
                ),
            ).toBe(false);
            expect(
                findRunIndex(mockSandbox, (cmd) =>
                    cmd.includes('kodus-graph parse --all'),
                ),
            ).toBeGreaterThan(0);
        });

        it('should call sandbox.readFile() to read graph JSON', async () => {
            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            expect(mockSandbox.readFile).toHaveBeenCalledWith(
                expect.stringContaining('graph.json'),
                expect.any(Object),
            );
        });

        it('should use sandbox.repoDir in commands, not hardcoded path', async () => {
            const customSandbox = createMockSandbox({
                repoDir: '/workspace/my-repo',
            });

            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: customSandbox,
                headSha: HEAD_SHA,
            });

            const parseIdx = findRunIndex(customSandbox, (cmd) =>
                cmd.includes('kodus-graph parse --all'),
            );
            const parseCmd = runCmd(customSandbox, parseIdx);
            expect(parseCmd).toContain('cd /workspace/my-repo');
            expect(parseCmd).not.toContain('/home/user/repo');

            const readFilePath = customSandbox.readFile.mock
                .calls[0][0] as string;
            expect(readFilePath).toContain('/workspace/my-repo');
        });

        it('should call astGraphRepo.fullRebuild() with parsed nodes/edges', async () => {
            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            expect(mockAstGraphRepo.fullRebuild).toHaveBeenCalledWith(
                REPO_ID,
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: 'function',
                        name: 'foo',
                    }),
                ]),
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: 'calls',
                        source_qualified: 'src/foo.ts::foo',
                    }),
                ]),
            );
        });

        it('should set status to BUILDING then READY on success', async () => {
            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            const calls = mockRepositoryRepo.updateGraphStatus.mock.calls;

            expect(calls[0]).toEqual([REPO_ID, AstGraphStatus.BUILDING]);

            const lastCall = calls[calls.length - 1];
            expect(lastCall[0]).toBe(REPO_ID);
            expect(lastCall[1]).toBe(AstGraphStatus.READY);
            expect(lastCall[2]).toEqual(
                expect.objectContaining({
                    sha: HEAD_SHA,
                    nodeCount: 1,
                    edgeCount: 1,
                }),
            );
        });

        it('should throw error on parse failure (exitCode !== 0)', async () => {
            // which-check + install succeed, parse --all fails
            mockSandbox.run
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({
                    stdout: '',
                    stderr: 'parse error',
                    exitCode: 1,
                });

            await expect(
                service.fullBuild({
                    repositoryId: REPO_ID,
                    sandbox: mockSandbox,
                    headSha: HEAD_SHA,
                }),
            ).rejects.toThrow('kodus-graph parse --all failed');

            expect(mockRepositoryRepo.updateGraphStatus).toHaveBeenCalledWith(
                REPO_ID,
                AstGraphStatus.FAILED,
            );
        });

        it('should mark status as FAILED on empty graph (0 nodes)', async () => {
            const emptyGraphJson = JSON.stringify({ nodes: [], edges: [] });
            mockSandbox.readFile.mockResolvedValue(emptyGraphJson);

            await service.fullBuild({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                headSha: HEAD_SHA,
            });

            expect(mockRepositoryRepo.updateGraphStatus).toHaveBeenCalledWith(
                REPO_ID,
                AstGraphStatus.FAILED,
            );

            expect(mockAstGraphRepo.fullRebuild).not.toHaveBeenCalled();
        });

        it('should mark status as FAILED on install error', async () => {
            // which-check returns 0 (empty), install returns 1
            mockSandbox.run
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValue({
                    stdout: '',
                    stderr: 'network error',
                    exitCode: 1,
                });

            await expect(
                service.fullBuild({
                    repositoryId: REPO_ID,
                    sandbox: mockSandbox,
                    headSha: HEAD_SHA,
                }),
            ).rejects.toThrow('kodus-graph install failed');

            expect(mockRepositoryRepo.updateGraphStatus).toHaveBeenCalledWith(
                REPO_ID,
                AstGraphStatus.FAILED,
            );
        });

        it('should mark status as FAILED on readFile error', async () => {
            mockSandbox.readFile.mockRejectedValue(new Error('File not found'));

            await expect(
                service.fullBuild({
                    repositoryId: REPO_ID,
                    sandbox: mockSandbox,
                    headSha: HEAD_SHA,
                }),
            ).rejects.toThrow('Failed to read graph file from sandbox');

            expect(mockRepositoryRepo.updateGraphStatus).toHaveBeenCalledWith(
                REPO_ID,
                AstGraphStatus.FAILED,
            );
        });
    });

    describe('incrementalUpdate', () => {
        const changedFiles = ['src/foo.ts', 'src/bar.ts'];
        const newSha = 'new-sha-789';

        it('should pass changed files to kodus-graph parse --files', async () => {
            await service.incrementalUpdate({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                changedFiles,
                newSha,
            });

            const parseIdx = findRunIndex(mockSandbox, (cmd) =>
                cmd.includes('kodus-graph parse --files'),
            );
            expect(parseIdx).toBeGreaterThanOrEqual(0);

            const parseCmd = runCmd(mockSandbox, parseIdx);
            expect(parseCmd).toContain('src/foo.ts');
            expect(parseCmd).toContain('src/bar.ts');
        });

        it('should call astGraphRepo.incrementalUpdate()', async () => {
            await service.incrementalUpdate({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                changedFiles,
                newSha,
            });

            expect(mockAstGraphRepo.incrementalUpdate).toHaveBeenCalledWith(
                REPO_ID,
                changedFiles,
                expect.any(Array),
                expect.any(Array),
            );
        });

        it('should update status to READY on success', async () => {
            await service.incrementalUpdate({
                repositoryId: REPO_ID,
                sandbox: mockSandbox,
                changedFiles,
                newSha,
            });

            expect(mockRepositoryRepo.updateGraphStatus).toHaveBeenCalledWith(
                REPO_ID,
                AstGraphStatus.READY,
                expect.objectContaining({
                    sha: newSha,
                    nodeCount: 1,
                    edgeCount: 1,
                }),
            );
        });

        it('should NOT set status to FAILED on error (graph is stale but usable)', async () => {
            // which-check + install succeed, parse --files fails
            mockSandbox.run
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
                .mockResolvedValueOnce({
                    stdout: '',
                    stderr: 'parse error',
                    exitCode: 1,
                });

            await expect(
                service.incrementalUpdate({
                    repositoryId: REPO_ID,
                    sandbox: mockSandbox,
                    changedFiles,
                    newSha,
                }),
            ).rejects.toThrow('kodus-graph parse --files failed');

            const failedCalls =
                mockRepositoryRepo.updateGraphStatus.mock.calls.filter(
                    (call) => call[1] === AstGraphStatus.FAILED,
                );
            expect(failedCalls).toHaveLength(0);
        });

        it('should use sandbox.repoDir in parse commands', async () => {
            const customSandbox = createMockSandbox({
                repoDir: '/workspace/project',
            });

            await service.incrementalUpdate({
                repositoryId: REPO_ID,
                sandbox: customSandbox,
                changedFiles,
                newSha,
            });

            const parseIdx = findRunIndex(customSandbox, (cmd) =>
                cmd.includes('kodus-graph parse --files'),
            );
            const parseCmd = runCmd(customSandbox, parseIdx);
            expect(parseCmd).toContain('cd /workspace/project');
        });
    });
});
