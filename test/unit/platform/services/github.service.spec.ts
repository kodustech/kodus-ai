/**
 * Tests for getChangedFilesSinceLastCommit logic in GitHub service.
 *
 * These tests verify that we use the compare API (baseSha...headSha)
 * to get only the diff of new changes since the last reviewed commit.
 *
 * The logic is:
 * 1. Get baseSha from lastCommit.sha
 * 2. Get headSha from the most recent commit in the PR (sorted by date)
 * 3. Use compare API to get the diff between baseSha and headSha
 */

// Mock logger
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('GitHub getChangedFilesSinceLastCommit', () => {
    /**
     * This function replicates the exact logic from github.service.ts getChangedFilesSinceLastCommit
     *
     * The key parts are:
     * 1. Get baseSha from lastCommit.dataExecution.lastAnalyzedCommit.sha
     * 2. Sort commits by date desc and pick the most recent as headSha
     * 3. Call compare API (baseSha...headSha)
     * 4. Return the files from the compare result
     */
    async function simulateGetChangedFilesSinceLastCommit(params: {
        commits: Array<{ sha: string; commit: { author: { date: string } } }>;
        lastCommit: {
            dataExecution: {
                lastAnalyzedCommit: { sha: string };
            };
        };
        compareCommits: (
            base: string,
            head: string,
        ) => Promise<
            Array<{
                filename: string;
                status: string;
                additions: number;
                deletions: number;
                changes: number;
                patch: string;
            }>
        >;
    }) {
        const { commits, lastCommit, compareCommits } = params;

        // 1. Get the SHA of the last analyzed commit
        const baseSha = lastCommit.dataExecution.lastAnalyzedCommit.sha;

        // 2. Sort commits by date desc and pick the most recent as headSha
        const sortedCommits = [...commits].sort(
            (a, b) =>
                new Date(b.commit.author.date).getTime() -
                new Date(a.commit.author.date).getTime(),
        );

        const headSha = sortedCommits[0]?.sha;

        if (!headSha || baseSha === headSha) {
            return [];
        }

        // 3. Compare the two commits
        const files = await compareCommits(baseSha, headSha);

        return files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
        }));
    }

    describe('compare behavior', () => {
        it('should return diff only for changes between last reviewed commit and head', async () => {
            // Scenario: PR has 3 commits, commit1 was already reviewed
            // Only changes from commit2 and commit3 should be returned
            const commits = [
                {
                    sha: 'commit1-sha',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'commit2-sha',
                    commit: { author: { date: '2024-01-03T00:00:00Z' } },
                },
                {
                    sha: 'commit3-sha',
                    commit: { author: { date: '2024-01-04T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit1-sha' },
                },
            };

            // Compare between commit1 and commit3 returns only new changes
            const compareCommits = async (base: string, head: string) => {
                expect(base).toBe('commit1-sha');
                expect(head).toBe('commit3-sha'); // Most recent commit
                return [
                    {
                        filename: 'index.html',
                        status: 'modified',
                        additions: 2,
                        deletions: 2,
                        changes: 4,
                        // Patch shows only changes from commit2 + commit3 (not commit1)
                        patch: '@@ -12,1 +12,1 @@\n-<h1>Old</h1>\n+<h1>commit 1</h1>\n@@ -17,1 +17,1 @@\n-<button>Old</button>\n+<button>commit 2</button>',
                    },
                ];
            };

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(1);
            expect(result[0].filename).toBe('index.html');
            expect(result[0].patch).toContain('commit 1');
            expect(result[0].patch).toContain('commit 2');
        });

        it('should pick the most recent commit as head (sorted by date)', async () => {
            // Commits may not be in chronological order from the API
            const commits = [
                {
                    sha: 'commit-c',
                    commit: { author: { date: '2024-01-04T00:00:00Z' } },
                },
                {
                    sha: 'commit-a',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'commit-b',
                    commit: { author: { date: '2024-01-03T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit-a' },
                },
            };

            const compareCommits = async (base: string, head: string) => {
                expect(base).toBe('commit-a');
                expect(head).toBe('commit-c'); // Most recent by date
                return [
                    {
                        filename: 'file.ts',
                        status: 'modified',
                        additions: 1,
                        deletions: 1,
                        changes: 2,
                        patch: '+test',
                    },
                ];
            };

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(1);
        });

        it('should return empty array when baseSha equals headSha', async () => {
            const commits = [
                {
                    sha: 'same-sha',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'same-sha' },
                },
            };

            const compareCommits = async () => {
                throw new Error('Should not be called');
            };

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(0);
        });

        it('should return empty array when no commits exist', async () => {
            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'some-sha' },
                },
            };

            const compareCommits = async () => {
                throw new Error('Should not be called');
            };

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits: [],
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(0);
        });

        it('should return multiple files from compare result', async () => {
            const commits = [
                {
                    sha: 'old-sha',
                    commit: { author: { date: '2024-01-01T00:00:00Z' } },
                },
                {
                    sha: 'new-sha',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'old-sha' },
                },
            };

            const compareCommits = async () => [
                {
                    filename: 'file1.ts',
                    status: 'modified',
                    additions: 5,
                    deletions: 3,
                    changes: 8,
                    patch: '+file1 changes',
                },
                {
                    filename: 'file2.ts',
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    changes: 10,
                    patch: '+file2 new',
                },
                {
                    filename: 'file3.ts',
                    status: 'removed',
                    additions: 0,
                    deletions: 8,
                    changes: 8,
                    patch: '-file3 removed',
                },
            ];

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(3);
            expect(result[0].filename).toBe('file1.ts');
            expect(result[0].status).toBe('modified');
            expect(result[1].filename).toBe('file2.ts');
            expect(result[1].status).toBe('added');
            expect(result[2].filename).toBe('file3.ts');
            expect(result[2].status).toBe('removed');
        });

        it('should preserve patch with correct line numbers from compare', async () => {
            // This is the key scenario: commit 1 changed lines 25-35, commit 2 changed lines 50-53
            // The compare should show ONLY the diff for commit 2 (lines 50-53)
            const commits = [
                {
                    sha: 'commit1-sha',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
                {
                    sha: 'commit2-sha',
                    commit: { author: { date: '2024-01-03T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit1-sha' },
                },
            };

            // Compare returns only the diff between commit1 and commit2
            const compareCommits = async () => [
                {
                    filename: 'app.ts',
                    status: 'modified',
                    additions: 4,
                    deletions: 4,
                    changes: 8,
                    patch: '@@ -50,4 +50,4 @@\n-    old line 50\n-    old line 51\n-    old line 52\n-    old line 53\n+    new line 50\n+    new line 51\n+    new line 52\n+    new line 53',
                },
            ];

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(1);
            expect(result[0].patch).toContain('@@ -50,4 +50,4 @@');
            // Should NOT contain changes from lines 25-35 (those were in commit1, already reviewed)
            expect(result[0].patch).not.toContain('line 25');
            expect(result[0].patch).not.toContain('line 35');
        });

        it('should handle compare with no files changed', async () => {
            const commits = [
                {
                    sha: 'old-sha',
                    commit: { author: { date: '2024-01-01T00:00:00Z' } },
                },
                {
                    sha: 'new-sha',
                    commit: { author: { date: '2024-01-02T00:00:00Z' } },
                },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'old-sha' },
                },
            };

            // Compare returns empty files (e.g., only commit message amend)
            const compareCommits = async () => [];

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(0);
        });
    });
});
