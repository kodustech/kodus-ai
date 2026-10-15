import { AgentReviewStage } from './agent-review.stage';

/**
 * Coding-agent instructions are read from the PR's target branch: what Kody
 * checks a PR against is what the team merged, never text the PR itself adds
 * or edits.
 */

const makeStage = () => {
    const codeManagementService = {
        getRepositoryAllFiles: jest
            .fn()
            .mockResolvedValue([{ path: 'CLAUDE.md' }]),
        getRepositoryContentFile: jest.fn().mockResolvedValue({
            data: { content: 'Amounts are integer cents.' },
        }),
    };
    const stage = new AgentReviewStage(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        codeManagementService as any,
    );
    return { stage, codeManagementService };
};

const context = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'repo-1' },
    branch: 'feature/x',
    pullRequest: {
        number: 7,
        head: { ref: 'feature/x' },
        base: { ref: 'release/2.0' },
    },
    codeReviewConfig: { repoInstructionsEnabled: true },
} as any;

describe('AgentReviewStage — repo instructions source branch', () => {
    it('lists and reads instruction files from the target branch', async () => {
        const { stage, codeManagementService } = makeStage();

        const result = await (stage as any).resolveRepoInstructions(
            context,
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

        expect(result.files.map((f: { path: string }) => f.path)).toEqual([
            'CLAUDE.md',
        ]);
        expect(
            codeManagementService.getRepositoryAllFiles.mock.calls[0][0]
                .filters.branch,
        ).toBe('release/2.0');
        const read =
            codeManagementService.getRepositoryContentFile.mock.calls[0][0];
        expect(read.pullRequest.head.ref).toBe('release/2.0');
        expect(read.pullRequest.base.ref).toBe('release/2.0');
    });

    it.each([
        ['the repository did not opt in', { repoInstructionsEnabled: false }],
        [
            'deep mode runs only category agents, which never render them',
            { repoInstructionsEnabled: true, reviewMode: 'deep' },
        ],
        [
            'bug, security and performance are all off, so the generalist does not run',
            {
                repoInstructionsEnabled: true,
                reviewOptions: { bug: false, security: false, performance: false },
            },
        ],
    ])('reads nothing when %s', async (_label, codeReviewConfig) => {
        const { stage, codeManagementService } = makeStage();

        const result = await (stage as any).resolveRepoInstructions(
            { ...context, codeReviewConfig },
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

        expect(result).toBeUndefined();
        expect(codeManagementService.getRepositoryAllFiles).not.toHaveBeenCalled();
        expect(
            codeManagementService.getRepositoryContentFile,
        ).not.toHaveBeenCalled();
    });

    it('reads nothing when the target branch is unknown', async () => {
        const { stage, codeManagementService } = makeStage();

        const result = await (stage as any).resolveRepoInstructions(
            { ...context, pullRequest: { number: 7, head: { ref: 'x' } } },
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

        expect(result).toBeUndefined();
        expect(codeManagementService.getRepositoryAllFiles).not.toHaveBeenCalled();
        expect(
            codeManagementService.getRepositoryContentFile,
        ).not.toHaveBeenCalled();
    });
});
