import { PullRequestHandlerService } from './pullRequestManager.service';

/**
 * Mutation-killing unit tests for the deterministic logic in
 * PullRequestHandlerService. The service is constructed with inert stub
 * dependencies; only `codeManagementService` is a controllable stub because
 * that is the sole collaborator the targeted methods touch. Private/no-op
 * dependencies (cacheService) are passed as `{}`.
 *
 * Methods under test:
 *  - getNewCommitsSinceLastExecution
 *  - enrichFilesWithContent
 *  - getChangedFilesMetadata
 */

const B64_HELLO = 'aGVsbG8gd29ybGQ='; // base64("hello world")

type CodeMgmtStub = {
    getCommitsForPullRequestForCodeReview: jest.Mock;
    getChangedFilesSinceLastCommit: jest.Mock;
    getFilesByPullRequestId: jest.Mock;
    getRepositoryContentBatch: jest.Mock;
    getRepositoryContentFile: jest.Mock;
};

function makeService(): {
    service: PullRequestHandlerService;
    codeManagementService: CodeMgmtStub;
} {
    const codeManagementService: CodeMgmtStub = {
        getCommitsForPullRequestForCodeReview: jest.fn(),
        getChangedFilesSinceLastCommit: jest.fn(),
        getFilesByPullRequestId: jest.fn(),
        getRepositoryContentBatch: jest.fn(),
        getRepositoryContentFile: jest.fn(),
    };

    const service = new PullRequestHandlerService(
        codeManagementService as any,
        {} as any, // cacheService — unused by the methods under test
    );

    return { service, codeManagementService };
}

const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { name: 'repo', id: 'repo-id' };
const pullRequest = { number: 42, head: { sha: 'head-sha-abc' } };

describe('PullRequestHandlerService.getNewCommitsSinceLastExecution', () => {
    it('passes prNumber and head.sha through to the commits fetch', async () => {
        const { service, codeManagementService } = makeService();
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            [{ sha: 'c1' }],
        );

        await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
        );

        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).toHaveBeenCalledTimes(1);
        expect(
            codeManagementService.getCommitsForPullRequestForCodeReview,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            headSha: 'head-sha-abc',
        });
    });

    it('returns [] when the fetch returns null', async () => {
        const { service, codeManagementService } = makeService();
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            null,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
        );

        expect(result).toEqual([]);
    });

    it('returns [] when the fetch returns an empty array', async () => {
        const { service, codeManagementService } = makeService();
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            [],
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
        );

        expect(result).toEqual([]);
    });

    it('returns ALL commits when lastCommit is undefined', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
        );

        expect(result).toEqual([{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }]);
    });

    it('returns ALL commits when lastCommit is present but has no sha', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [{ sha: 'c1' }, { sha: 'c2' }];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
            { sha: undefined },
        );

        expect(result).toEqual([{ sha: 'c1' }, { sha: 'c2' }]);
    });

    it('returns ALL commits when lastCommit.sha is not found among commits', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
            { sha: 'does-not-exist' },
        );

        expect(result).toEqual([{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }]);
    });

    it('returns only commits AFTER the matched lastCommit (excludes the match) — middle match', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [
            { sha: 'c1' },
            { sha: 'c2' },
            { sha: 'c3' },
            { sha: 'c4' },
        ];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
            { sha: 'c2' },
        );

        // slice(index+1): matched commit c2 is excluded, c3 and c4 remain in order.
        expect(result).toEqual([{ sha: 'c3' }, { sha: 'c4' }]);
    });

    it('returns [] when the matched lastCommit is the last commit', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
            { sha: 'c3' },
        );

        expect(result).toEqual([]);
    });

    it('returns all-but-first when the matched lastCommit is the first commit', async () => {
        const { service, codeManagementService } = makeService();
        const commits = [{ sha: 'c1' }, { sha: 'c2' }];
        codeManagementService.getCommitsForPullRequestForCodeReview.mockResolvedValue(
            commits,
        );

        const result = await (service as any).getNewCommitsSinceLastExecution(
            orgData,
            repository,
            pullRequest,
            { sha: 'c1' },
        );

        expect(result).toEqual([{ sha: 'c2' }]);
    });

    it('rethrows when the underlying fetch rejects', async () => {
        const { service, codeManagementService } = makeService();
        const boom = new Error('boom');
        codeManagementService.getCommitsForPullRequestForCodeReview.mockRejectedValue(
            boom,
        );

        await expect(
            (service as any).getNewCommitsSinceLastExecution(
                orgData,
                repository,
                pullRequest,
            ),
        ).rejects.toBe(boom);
    });
});

describe('PullRequestHandlerService.getChangedFilesMetadata', () => {
    it('uses getChangedFilesSinceLastCommit when lastCommit is provided', async () => {
        const { service, codeManagementService } = makeService();
        const files = [{ filename: 'a.ts', status: 'modified' }];
        codeManagementService.getChangedFilesSinceLastCommit.mockResolvedValue(
            files,
        );

        const result = await (service as any).getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
            'last-sha',
        );

        expect(result).toEqual([{ filename: 'a.ts', status: 'modified' }]);
        expect(
            codeManagementService.getChangedFilesSinceLastCommit,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            lastCommit: 'last-sha',
        });
        expect(
            codeManagementService.getFilesByPullRequestId,
        ).not.toHaveBeenCalled();
    });

    it('uses getFilesByPullRequestId (with headSha) when lastCommit is absent', async () => {
        const { service, codeManagementService } = makeService();
        const files = [{ filename: 'b.ts', status: 'added' }];
        codeManagementService.getFilesByPullRequestId.mockResolvedValue(files);

        const result = await (service as any).getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
        );

        expect(result).toEqual([{ filename: 'b.ts', status: 'added' }]);
        expect(
            codeManagementService.getFilesByPullRequestId,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: orgData,
            repository,
            prNumber: 42,
            headSha: 'head-sha-abc',
        });
        expect(
            codeManagementService.getChangedFilesSinceLastCommit,
        ).not.toHaveBeenCalled();
    });

    it('returns [] when the fetch resolves null (lastCommit path)', async () => {
        const { service, codeManagementService } = makeService();
        codeManagementService.getChangedFilesSinceLastCommit.mockResolvedValue(
            null,
        );

        const result = await (service as any).getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
            'last-sha',
        );

        expect(result).toEqual([]);
    });

    it('returns [] when the fetch resolves undefined (no-lastCommit path)', async () => {
        const { service, codeManagementService } = makeService();
        codeManagementService.getFilesByPullRequestId.mockResolvedValue(
            undefined,
        );

        const result = await (service as any).getChangedFilesMetadata(
            orgData,
            repository,
            pullRequest,
        );

        expect(result).toEqual([]);
    });

    it('rethrows when the underlying fetch rejects', async () => {
        const { service, codeManagementService } = makeService();
        const boom = new Error('meta-boom');
        codeManagementService.getFilesByPullRequestId.mockRejectedValue(boom);

        await expect(
            (service as any).getChangedFilesMetadata(
                orgData,
                repository,
                pullRequest,
            ),
        ).rejects.toBe(boom);
    });
});

describe('PullRequestHandlerService.enrichFilesWithContent', () => {
    it('returns [] when files is null without calling any fetch', async () => {
        const { service, codeManagementService } = makeService();

        const result = await (service as any).enrichFilesWithContent(
            orgData,
            repository,
            pullRequest,
            null,
        );

        expect(result).toEqual([]);
        expect(
            codeManagementService.getRepositoryContentBatch,
        ).not.toHaveBeenCalled();
        expect(
            codeManagementService.getRepositoryContentFile,
        ).not.toHaveBeenCalled();
    });

    it('returns [] when files is an empty array without calling any fetch', async () => {
        const { service, codeManagementService } = makeService();

        const result = await (service as any).enrichFilesWithContent(
            orgData,
            repository,
            pullRequest,
            [],
        );

        expect(result).toEqual([]);
        expect(
            codeManagementService.getRepositoryContentBatch,
        ).not.toHaveBeenCalled();
    });

    describe('batch path', () => {
        it('decodes base64 content from the batch map and merges it onto the file', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'a.ts', status: 'modified' };
            const batchMap = new Map<string, any>([
                ['a.ts', { data: { content: B64_HELLO, encoding: 'base64' } }],
            ]);
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                batchMap,
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                {
                    filename: 'a.ts',
                    status: 'modified',
                    fileContent: 'hello world',
                },
            ]);
            // Batch path must NOT fall through to per-file REST.
            expect(
                codeManagementService.getRepositoryContentFile,
            ).not.toHaveBeenCalled();
        });

        it('returns raw content when encoding is not base64', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'plain.ts', status: 'modified' };
            const batchMap = new Map<string, any>([
                [
                    'plain.ts',
                    { data: { content: 'raw source', encoding: 'utf-8' } },
                ],
            ]);
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                batchMap,
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                {
                    filename: 'plain.ts',
                    status: 'modified',
                    fileContent: 'raw source',
                },
            ]);
        });

        it('does NOT base64-decode when content is not a string even if encoding is base64', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'weird.ts', status: 'modified' };
            const batchMap = new Map<string, any>([
                ['weird.ts', { data: { content: 12345, encoding: 'base64' } }],
            ]);
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                batchMap,
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                {
                    filename: 'weird.ts',
                    status: 'modified',
                    fileContent: 12345,
                },
            ]);
        });

        it('returns the file UNCHANGED (no fileContent key) when batch map has no entry for it', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'missing.ts', status: 'modified' };
            const batchMap = new Map<string, any>(); // empty
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                batchMap,
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                { filename: 'missing.ts', status: 'modified' },
            ]);
            expect(result[0]).not.toHaveProperty('fileContent');
        });

        it('maps each file independently: hit gets content, miss stays untouched, order preserved', async () => {
            const { service, codeManagementService } = makeService();
            const files = [
                { filename: 'hit.ts', status: 'modified' },
                { filename: 'miss.ts', status: 'added' },
            ];
            const batchMap = new Map<string, any>([
                [
                    'hit.ts',
                    { data: { content: B64_HELLO, encoding: 'base64' } },
                ],
            ]);
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                batchMap,
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                files,
            );

            expect(result).toEqual([
                {
                    filename: 'hit.ts',
                    status: 'modified',
                    fileContent: 'hello world',
                },
                { filename: 'miss.ts', status: 'added' },
            ]);
        });
    });

    describe('per-file REST fallback', () => {
        it('falls back to per-file REST when batch returns null', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'a.ts', status: 'modified' };
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                null,
            );
            codeManagementService.getRepositoryContentFile.mockResolvedValue({
                data: { content: B64_HELLO, encoding: 'base64' },
            });

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                {
                    filename: 'a.ts',
                    status: 'modified',
                    fileContent: 'hello world',
                },
            ]);
            expect(
                codeManagementService.getRepositoryContentFile,
            ).toHaveBeenCalledTimes(1);
            expect(
                codeManagementService.getRepositoryContentFile,
            ).toHaveBeenCalledWith({
                organizationAndTeamData: orgData,
                repository,
                file,
                pullRequest,
            });
        });

        it('falls back to per-file REST when the batch method THROWS', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'a.ts', status: 'modified' };
            codeManagementService.getRepositoryContentBatch.mockRejectedValue(
                new Error('graphql exploded'),
            );
            codeManagementService.getRepositoryContentFile.mockResolvedValue({
                data: { content: 'plain', encoding: 'utf-8' },
            });

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([
                {
                    filename: 'a.ts',
                    status: 'modified',
                    fileContent: 'plain',
                },
            ]);
            expect(
                codeManagementService.getRepositoryContentFile,
            ).toHaveBeenCalledTimes(1);
        });

        it('returns the file UNCHANGED when a per-file content fetch throws', async () => {
            const { service, codeManagementService } = makeService();
            const file = { filename: 'a.ts', status: 'modified' };
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                null,
            );
            codeManagementService.getRepositoryContentFile.mockRejectedValue(
                new Error('404'),
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            );

            expect(result).toEqual([{ filename: 'a.ts', status: 'modified' }]);
            expect(result[0]).not.toHaveProperty('fileContent');
        });

        it('preserves file order in the per-file fallback across multiple files', async () => {
            const { service, codeManagementService } = makeService();
            const files = [
                { filename: 'first.ts', status: 'modified' },
                { filename: 'second.ts', status: 'added' },
            ];
            codeManagementService.getRepositoryContentBatch.mockResolvedValue(
                null,
            );
            codeManagementService.getRepositoryContentFile.mockImplementation(
                async ({ file }: any) => ({
                    data: {
                        content: `content-of-${file.filename}`,
                        encoding: 'utf-8',
                    },
                }),
            );

            const result = await (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                files,
            );

            expect(result).toEqual([
                {
                    filename: 'first.ts',
                    status: 'modified',
                    fileContent: 'content-of-first.ts',
                },
                {
                    filename: 'second.ts',
                    status: 'added',
                    fileContent: 'content-of-second.ts',
                },
            ]);
        });
    });

    it('rethrows from the outer catch when a truthy non-Map batch result breaks mapping', async () => {
        const { service, codeManagementService } = makeService();
        const file = { filename: 'a.ts', status: 'modified' };
        // Truthy value whose `.get` is not a function -> `batchMap.get(...)`
        // throws inside files.map, caught by the outer try/catch which rethrows.
        codeManagementService.getRepositoryContentBatch.mockResolvedValue({
            notAMap: true,
        });

        await expect(
            (service as any).enrichFilesWithContent(
                orgData,
                repository,
                pullRequest,
                [file],
            ),
        ).rejects.toBeInstanceOf(TypeError);
    });
});
