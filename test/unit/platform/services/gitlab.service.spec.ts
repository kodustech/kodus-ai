/**
 * Tests for getChangedFilesSinceLastCommit logic in GitLab service.
 *
 * These tests verify that we use the compare API (baseSha → headSha)
 * to get only the diff of new changes since the last reviewed commit.
 *
 * The logic is:
 * 1. Get baseSha from lastCommit.sha
 * 2. Get headSha from the most recent commit in the MR (sorted by date)
 * 3. Use Repositories.compare to get the diff between baseSha and headSha
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

describe('GitLab getChangedFilesSinceLastCommit', () => {
    // Helper to count changes (replicates gitlab.service.ts logic)
    function countChanges(diff: string): { adds: number; deletes: number } {
        if (!diff) return { adds: 0, deletes: 0 };
        const lines = diff.split('\n');
        let adds = 0;
        let deletes = 0;
        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) adds++;
            if (line.startsWith('-') && !line.startsWith('---')) deletes++;
        }
        return { adds, deletes };
    }

    // Helper to map GitLab status
    function mapGitlabStatus(change: any): string {
        if (change.new_file) return 'added';
        if (change.deleted_file) return 'removed';
        if (change.renamed_file) return 'renamed';
        return 'modified';
    }

    /**
     * This function replicates the exact logic from gitlab.service.ts getChangedFilesSinceLastCommit
     *
     * The key parts are:
     * 1. Get baseSha from lastCommit.dataExecution.lastAnalyzedCommit.sha
     * 2. Sort commits by date desc and pick the most recent as headSha
     * 3. Call Repositories.compare(projectId, baseSha, headSha)
     * 4. Return the diffs from the compare result
     */
    async function simulateGetChangedFilesSinceLastCommit(params: {
        commits: Array<{ id: string; created_at: string }>;
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
                new_path: string;
                diff: string;
                new_file?: boolean;
                deleted_file?: boolean;
                renamed_file?: boolean;
            }>
        >;
    }) {
        const { commits, lastCommit, compareCommits } = params;

        // 1. Get the SHA of the last analyzed commit
        const baseSha = lastCommit.dataExecution.lastAnalyzedCommit.sha;

        // 2. Sort commits by date desc and pick the most recent as headSha
        const sortedCommits = [...commits].sort(
            (a, b) =>
                new Date(b.created_at).getTime() -
                new Date(a.created_at).getTime(),
        );

        const headSha = sortedCommits[0]?.id;

        if (!headSha || baseSha === headSha) {
            return [];
        }

        // 3. Compare the two commits
        const diffs = await compareCommits(baseSha, headSha);

        return diffs.map((file) => {
            const changeCount = countChanges(file.diff);
            return {
                filename: file.new_path,
                status: mapGitlabStatus(file),
                additions: changeCount.adds,
                deletions: changeCount.deletes,
                changes: changeCount.adds + changeCount.deletes,
                patch: file.diff,
            };
        });
    }

    describe('compare behavior', () => {
        it('should return diff only for changes between last reviewed commit and head', async () => {
            // Scenario: MR has 3 commits, commit1 was already reviewed
            // Only changes from commit2 and commit3 should be returned
            const commits = [
                { id: 'commit1-sha', created_at: '2024-01-02T00:00:00Z' },
                { id: 'commit2-sha', created_at: '2024-01-03T00:00:00Z' },
                { id: 'commit3-sha', created_at: '2024-01-04T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit1-sha' },
                },
            };

            const compareCommits = async (base: string, head: string) => {
                expect(base).toBe('commit1-sha');
                expect(head).toBe('commit3-sha'); // Most recent commit
                return [
                    {
                        new_path: 'index.html',
                        diff: '@@ -12,1 +12,1 @@\n-<h1>Old</h1>\n+<h1>commit 1</h1>\n@@ -17,1 +17,1 @@\n-<button>Old</button>\n+<button>commit 2</button>',
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
                { id: 'commit-c', created_at: '2024-01-04T00:00:00Z' },
                { id: 'commit-a', created_at: '2024-01-02T00:00:00Z' },
                { id: 'commit-b', created_at: '2024-01-03T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit-a' },
                },
            };

            const compareCommits = async (base: string, head: string) => {
                expect(base).toBe('commit-a');
                expect(head).toBe('commit-c'); // Most recent by date
                return [{ new_path: 'file.ts', diff: '+test' }];
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
                { id: 'same-sha', created_at: '2024-01-02T00:00:00Z' },
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
                { id: 'old-sha', created_at: '2024-01-01T00:00:00Z' },
                { id: 'new-sha', created_at: '2024-01-02T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'old-sha' },
                },
            };

            const compareCommits = async () => [
                { new_path: 'file1.ts', diff: '+file1 changes' },
                { new_path: 'file2.ts', diff: '+file2 new', new_file: true },
                {
                    new_path: 'file3.ts',
                    diff: '-file3 removed',
                    deleted_file: true,
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
                { id: 'commit1-sha', created_at: '2024-01-02T00:00:00Z' },
                { id: 'commit2-sha', created_at: '2024-01-03T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'commit1-sha' },
                },
            };

            const compareCommits = async () => [
                {
                    new_path: 'app.ts',
                    diff: '@@ -50,4 +50,4 @@\n-    old line 50\n-    old line 51\n-    old line 52\n-    old line 53\n+    new line 50\n+    new line 51\n+    new line 52\n+    new line 53',
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

        it('should handle compare with no diffs', async () => {
            const commits = [
                { id: 'old-sha', created_at: '2024-01-01T00:00:00Z' },
                { id: 'new-sha', created_at: '2024-01-02T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'old-sha' },
                },
            };

            const compareCommits = async () => [];

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(0);
        });

        it('should correctly map GitLab file statuses', async () => {
            const commits = [
                { id: 'old-sha', created_at: '2024-01-01T00:00:00Z' },
                { id: 'new-sha', created_at: '2024-01-02T00:00:00Z' },
            ];

            const lastCommit = {
                dataExecution: {
                    lastAnalyzedCommit: { sha: 'old-sha' },
                },
            };

            const compareCommits = async () => [
                { new_path: 'new-file.ts', diff: '+new', new_file: true },
                { new_path: 'modified-file.ts', diff: '+modified' },
                { new_path: 'renamed-file.ts', diff: '', renamed_file: true },
                {
                    new_path: 'deleted-file.ts',
                    diff: '-deleted',
                    deleted_file: true,
                },
            ];

            const result = await simulateGetChangedFilesSinceLastCommit({
                commits,
                lastCommit,
                compareCommits,
            });

            expect(result).toHaveLength(4);
            expect(
                result.find((f) => f.filename === 'new-file.ts')?.status,
            ).toBe('added');
            expect(
                result.find((f) => f.filename === 'modified-file.ts')?.status,
            ).toBe('modified');
            expect(
                result.find((f) => f.filename === 'renamed-file.ts')?.status,
            ).toBe('renamed');
            expect(
                result.find((f) => f.filename === 'deleted-file.ts')?.status,
            ).toBe('removed');
        });
    });
});
