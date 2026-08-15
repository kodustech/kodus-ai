import {
    TRACE_BRANCH,
    TraceDecisionBranchReaderService,
    traceRecordPath,
} from '../trace-decision-branch-reader.service';

const decision = (text: string) => ({
    type: 'convention' as const,
    decision: text,
    confidence: 0.9,
    scope: ['src/index.ts'],
});

describe('TraceDecisionBranchReaderService', () => {
    const codeManagement = {
        getRepositoryContentFile: jest.fn(),
    };
    const reader = new TraceDecisionBranchReaderService(codeManagement as any);

    beforeEach(() => jest.clearAllMocks());

    it('reads the exact branch shard from the requested repository and team', async () => {
        codeManagement.getRepositoryContentFile.mockImplementation(
            async ({ repository }) => ({
                data: {
                    encoding: 'base64',
                    content: Buffer.from(
                        JSON.stringify({
                            version: 1,
                            branch: 'main',
                            decisions: [decision(`${repository.id} decision`)],
                        }),
                    ).toString('base64'),
                },
            }),
        );

        const repoA = await reader.read({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-a',
            },
            repository: { id: 'repo-a', name: 'repo-a' },
            branch: 'main',
        });
        const repoB = await reader.read({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-b',
            },
            repository: { id: 'repo-b', name: 'repo-b' },
            branch: 'main',
        });

        expect(repoA?.decisions[0].decision).toBe('repo-a decision');
        expect(repoB?.decisions[0].decision).toBe('repo-b decision');
        expect(codeManagement.getRepositoryContentFile).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-a',
                },
                repository: { id: 'repo-a', name: 'repo-a' },
                file: { filename: traceRecordPath('main') },
                pullRequest: {
                    head: { ref: TRACE_BRANCH },
                    base: { ref: TRACE_BRANCH },
                },
                suppressNotFoundLogs: true,
            }),
        );
    });

    it('returns null when the provider has no Trace ref', async () => {
        codeManagement.getRepositoryContentFile.mockResolvedValue(null);
        await expect(
            reader.read({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'repo-1' },
                branch: 'main',
            }),
        ).resolves.toBeNull();
    });

    it('normalizes a provider refs/heads branch to the CLI destination key', async () => {
        codeManagement.getRepositoryContentFile.mockResolvedValue({
            data: {
                encoding: 'utf-8',
                content: JSON.stringify({
                    version: 1,
                    branch: 'feature-x',
                    decisions: [decision('feature decision')],
                }),
            },
        });

        await expect(
            reader.read({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'repo-1' },
                branch: 'refs/heads/feature-x',
            }),
        ).resolves.toMatchObject({ branch: 'feature-x' });
        expect(codeManagement.getRepositoryContentFile).toHaveBeenCalledWith(
            expect.objectContaining({
                file: { filename: traceRecordPath('feature-x') },
            }),
        );
    });

    it('rejects content for another branch returned by a provider fallback', async () => {
        codeManagement.getRepositoryContentFile.mockResolvedValue({
            data: {
                encoding: 'utf-8',
                content: JSON.stringify({
                    version: 1,
                    branch: 'not-main',
                    decisions: [decision('wrong branch')],
                }),
            },
        });

        await expect(
            reader.read({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: { id: 'repo-1', name: 'repo-1' },
                branch: 'main',
            }),
        ).resolves.toBeNull();
    });

    it('does not issue an unscoped request', async () => {
        await expect(
            reader.read({
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'repo-1', name: 'repo-1' },
                branch: 'main',
            }),
        ).resolves.toBeNull();
        expect(codeManagement.getRepositoryContentFile).not.toHaveBeenCalled();
    });
});
