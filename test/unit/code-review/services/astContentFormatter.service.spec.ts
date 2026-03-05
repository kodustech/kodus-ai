import { Test, TestingModule } from '@nestjs/testing';
import { ASTContentFormatterService } from '@/code-review/infrastructure/adapters/services/astContentFormatter.service';
import { AST_ANALYSIS_SERVICE_TOKEN } from '@/code-review/domain/contracts/ASTAnalysisService.contract';
import {
    FileContentFlag,
    TaskStatus,
} from '@/ee/kodyAST/interfaces/code-ast-analysis.interface';
import { encrypt } from '@/common/utils/crypto';
import { promisify } from 'util';
import { gzip } from 'zlib';
import {
    AnalysisContext,
    FileChange,
} from '@/core/infrastructure/config/types/general/codeReview.type';

const gzipAsync = promisify(gzip);

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Mock AxiosASTService — POST (initialize) and GET (result) go through this
const mockPost = jest.fn();
const mockGet = jest.fn();

jest.mock(
    '@libs/core/infrastructure/config/axios/microservices/ast.axios',
    () => ({
        AxiosASTService: jest.fn().mockImplementation(() => ({
            post: mockPost,
            get: mockGet,
        })),
    }),
);

/**
 * Helper: compress and encrypt a string the same way the service does,
 * so we can build realistic AST responses in tests.
 */
async function compressAndEncrypt(text: string): Promise<string> {
    if (!text) return encrypt('');
    const compressed = await gzipAsync(Buffer.from(text, 'utf-8'));
    const base64 = compressed.toString('base64');
    return encrypt(base64);
}

function createFileChange(
    overrides: Partial<FileChange> & { filename: string },
): FileChange {
    return {
        content: null,
        sha: 'abc123',
        status: 'modified',
        additions: 5,
        deletions: 2,
        changes: 7,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        patch: '@@ -1,5 +1,5 @@\n-old line\n+new line',
        fileContent: 'const x = 1;\nconst y = 2;',
        ...overrides,
    } as FileChange;
}

function createContext(
    overrides: Partial<AnalysisContext> = {},
): AnalysisContext {
    return {
        organizationAndTeamData: {
            organizationId: 'org-123',
            teamId: 'team-456',
        },
        pullRequest: {
            number: 42,
            base: { repo: { fullName: 'org/repo' } },
        },
        platformType: 'github',
        tasks: { astAnalysis: { taskId: 'task-1' } },
        ...overrides,
    } as any;
}

const mockAwaitTask = jest.fn();

const mockAstAnalysisService = {
    awaitTask: mockAwaitTask,
};

describe('ASTContentFormatterService', () => {
    let service: ASTContentFormatterService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ASTContentFormatterService,
                {
                    provide: AST_ANALYSIS_SERVICE_TOKEN,
                    useValue: mockAstAnalysisService,
                },
            ],
        }).compile();

        service = module.get<ASTContentFormatterService>(
            ASTContentFormatterService,
        );
        jest.clearAllMocks();

        // Default: awaitTask returns COMPLETED
        mockAwaitTask.mockResolvedValue({
            task: {
                taskId: 'task-1',
                status: TaskStatus.TASK_STATUS_COMPLETED,
            },
        });
    });

    describe('round-trip compress + encrypt', () => {
        it('should produce content that survives compress→encrypt→decrypt→decompress', async () => {
            const originalContent = 'function hello() {\n  return "world";\n}';
            const formattedContent =
                '// AST formatted\nfunction hello() {\n  return "world";\n}';

            const encryptedResponse =
                await compressAndEncrypt(formattedContent);

            const file = createFileChange({
                filename: 'src/hello.ts',
                fileContent: originalContent,
            });

            mockPost.mockImplementation(async (_url, body) => {
                // Configure GET to respond with the same IDs from POST
                mockGet.mockResolvedValue({
                    result: {
                        files: body.files.map((f: any) => ({
                            id: f.id,
                            content: encryptedResponse,
                            flag: FileContentFlag.DIFF,
                        })),
                    },
                });

                return { taskId: 'task-roundtrip' };
            });

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(1);
            expect(result.get('src/hello.ts')?.content).toBe(formattedContent);
            expect(result.get('src/hello.ts')?.flag).toBe(FileContentFlag.DIFF);
        });
    });

    describe('language filtering', () => {
        it('should only send files with supported extensions to AST', async () => {
            const tsFile = createFileChange({ filename: 'src/app.ts' });
            const pyFile = createFileChange({ filename: 'src/main.py' });
            const mdFile = createFileChange({ filename: 'README.md' });
            const yamlFile = createFileChange({ filename: 'config.yaml' });

            const encryptedContent = await compressAndEncrypt('formatted');

            mockPost.mockImplementation(async (_url, body) => {
                mockGet.mockResolvedValue({
                    result: {
                        files: body.files.map((f: any) => ({
                            id: f.id,
                            content: encryptedContent,
                            flag: FileContentFlag.FULL,
                        })),
                    },
                });
                return { taskId: 'task-filter' };
            });

            const result = await service.fetchFormattedContent(
                [tsFile, pyFile, mdFile, yamlFile],
                createContext(),
            );

            // Only .ts and .py are supported
            expect(result.size).toBe(2);
            expect(result.has('src/app.ts')).toBe(true);
            expect(result.has('src/main.py')).toBe(true);
            expect(result.has('README.md')).toBe(false);
            expect(result.has('config.yaml')).toBe(false);

            // POST should have been called with only 2 files
            expect(mockPost).toHaveBeenCalledTimes(1);
            const postedFiles = mockPost.mock.calls[0][1].files;
            expect(postedFiles).toHaveLength(2);
        });

        it('should return empty map when no files have supported extensions', async () => {
            const mdFile = createFileChange({ filename: 'README.md' });
            const yamlFile = createFileChange({ filename: 'config.yaml' });

            const result = await service.fetchFormattedContent(
                [mdFile, yamlFile],
                createContext(),
            );

            expect(result.size).toBe(0);
            expect(mockPost).not.toHaveBeenCalled();
        });
    });

    describe('AST returns formatted content (happy path)', () => {
        it('should return formatted content for all files in batch', async () => {
            const file1 = createFileChange({
                filename: 'src/service.ts',
                fileContent: 'original content 1',
            });
            const file2 = createFileChange({
                filename: 'src/controller.ts',
                fileContent: 'original content 2',
            });

            const formatted1 = await compressAndEncrypt(
                'AST formatted content 1',
            );
            const formatted2 = await compressAndEncrypt(
                'AST formatted content 2',
            );

            mockPost.mockImplementation(async (_url, body) => {
                mockGet.mockResolvedValue({
                    result: {
                        files: [
                            {
                                id: body.files[0].id,
                                content: formatted1,
                                flag: FileContentFlag.DIFF,
                            },
                            {
                                id: body.files[1].id,
                                content: formatted2,
                                flag: FileContentFlag.FULL,
                            },
                        ],
                    },
                });
                return { taskId: 'task-happy' };
            });

            const result = await service.fetchFormattedContent(
                [file1, file2],
                createContext(),
            );

            expect(result.size).toBe(2);
            expect(result.get('src/service.ts')).toEqual({
                content: 'AST formatted content 1',
                flag: FileContentFlag.DIFF,
            });
            expect(result.get('src/controller.ts')).toEqual({
                content: 'AST formatted content 2',
                flag: FileContentFlag.FULL,
            });
        });
    });

    describe('AST failure fallback', () => {
        it('should return empty map when POST fails (AST offline)', async () => {
            const file = createFileChange({ filename: 'src/app.ts' });

            mockPost.mockRejectedValue(new Error('ECONNREFUSED'));

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(0);
        });

        it('should return empty map when POST returns no taskId', async () => {
            const file = createFileChange({ filename: 'src/app.ts' });

            mockPost.mockResolvedValue({ taskId: null });

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(0);
            expect(mockAwaitTask).not.toHaveBeenCalled();
        });
    });

    describe('partial AST response', () => {
        it('should return content only for files present in AST response', async () => {
            const file1 = createFileChange({ filename: 'src/a.ts' });
            const file2 = createFileChange({ filename: 'src/b.ts' });
            const file3 = createFileChange({ filename: 'src/c.py' });

            const formatted1 = await compressAndEncrypt('formatted a');

            mockPost.mockImplementation(async (_url, body) => {
                // AST only returns content for file1, skips file2 and file3
                mockGet.mockResolvedValue({
                    result: {
                        files: [
                            {
                                id: body.files[0].id,
                                content: formatted1,
                                flag: FileContentFlag.SIMPLE,
                            },
                        ],
                    },
                });
                return { taskId: 'task-partial' };
            });

            const result = await service.fetchFormattedContent(
                [file1, file2, file3],
                createContext(),
            );

            expect(result.size).toBe(1);
            expect(result.get('src/a.ts')?.content).toBe('formatted a');
            expect(result.has('src/b.ts')).toBe(false);
            expect(result.has('src/c.py')).toBe(false);
        });
    });

    describe('decrypt/decompress failure for a single file', () => {
        it('should skip corrupted file and return others successfully', async () => {
            const file1 = createFileChange({ filename: 'src/good.ts' });
            const file2 = createFileChange({ filename: 'src/bad.ts' });
            const file3 = createFileChange({ filename: 'src/also-good.ts' });

            const goodContent = await compressAndEncrypt('good formatted');
            const corruptedContent = 'not-valid-encrypted-data';
            const alsoGoodContent = await compressAndEncrypt(
                'also good formatted',
            );

            mockPost.mockImplementation(async (_url, body) => {
                mockGet.mockResolvedValue({
                    result: {
                        files: [
                            {
                                id: body.files[0].id,
                                content: goodContent,
                                flag: FileContentFlag.DIFF,
                            },
                            {
                                id: body.files[1].id,
                                content: corruptedContent,
                                flag: FileContentFlag.DIFF,
                            },
                            {
                                id: body.files[2].id,
                                content: alsoGoodContent,
                                flag: FileContentFlag.FULL,
                            },
                        ],
                    },
                });
                return { taskId: 'task-corrupt' };
            });

            const result = await service.fetchFormattedContent(
                [file1, file2, file3],
                createContext(),
            );

            // file2 should be skipped due to corrupted data
            expect(result.size).toBe(2);
            expect(result.get('src/good.ts')?.content).toBe('good formatted');
            expect(result.has('src/bad.ts')).toBe(false);
            expect(result.get('src/also-good.ts')?.content).toBe(
                'also good formatted',
            );
        });
    });

    describe('awaitTask failure (task not completed)', () => {
        it('should return empty map when task fails', async () => {
            const file = createFileChange({ filename: 'src/app.ts' });

            mockPost.mockResolvedValue({ taskId: 'task-fail' });
            mockAwaitTask.mockResolvedValue({
                task: {
                    taskId: 'task-fail',
                    status: TaskStatus.TASK_STATUS_FAILED,
                },
            });

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(0);
            expect(mockGet).not.toHaveBeenCalled();
        });

        it('should return empty map when awaitTask throws (timeout)', async () => {
            const file = createFileChange({ filename: 'src/app.ts' });

            mockPost.mockResolvedValue({ taskId: 'task-timeout' });
            mockAwaitTask.mockRejectedValue(
                new Error('Task task-timeout timed out after 60000ms'),
            );

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(0);
        });

        it('should return empty map when awaitTask returns null', async () => {
            const file = createFileChange({ filename: 'src/app.ts' });

            mockPost.mockResolvedValue({ taskId: 'task-null' });
            mockAwaitTask.mockResolvedValue(null);

            const result = await service.fetchFormattedContent(
                [file],
                createContext(),
            );

            expect(result.size).toBe(0);
        });
    });
});
