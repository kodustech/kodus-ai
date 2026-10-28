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
        // A listing failure must not look like a repository without the files.
        expect(
            codeManagementService.getRepositoryAllFiles.mock.calls[0][0]
                .throwOnError,
        ).toBe(true);
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

    it.each([
        [
            'wrapped in data (GitHub, GitLab, Azure)',
            {
                data: {
                    content: Buffer.from('Amounts are integer cents.').toString(
                        'base64',
                    ),
                    encoding: 'base64',
                },
            },
        ],
        [
            'flat, already decoded (Forgejo)',
            { content: 'Amounts are integer cents.', encoding: 'utf-8' },
        ],
    ])('reads a file whose content comes back %s', async (_label, response) => {
        const { stage, codeManagementService } = makeStage();
        codeManagementService.getRepositoryContentFile.mockResolvedValue(
            response,
        );

        const result = await (stage as any).resolveRepoInstructions(
            context,
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

        expect(result.files[0].content).toBe('Amounts are integer cents.');
    });

    it('warns with the files it could not read', async () => {
        const { stage, codeManagementService } = makeStage();
        codeManagementService.getRepositoryAllFiles.mockResolvedValue([
            { path: 'CLAUDE.md' },
            { path: 'AGENTS.md' },
        ]);
        codeManagementService.getRepositoryContentFile.mockImplementation(
            async ({ file }: { file: { filename: string } }) => {
                if (file.filename === 'AGENTS.md') throw new Error('502');
                return { data: { content: 'Use pnpm.' } };
            },
        );
        const warn = jest.spyOn((stage as any).logger, 'warn');

        await (stage as any).resolveRepoInstructions(
            context,
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    unreadable: ['AGENTS.md: 502'],
                }),
            }),
        );
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

// GitLab and Bitbucket list a whole tree in pages; the index of instruction
// files is the same for every review against one target-branch commit.
describe('AgentReviewStage — instruction index cache', () => {
    const makeCachedStage = () => {
        const store = new Map<string, unknown>();
        const cacheService = {
            getFromCache: jest.fn(
                async (key: string) => store.get(key) ?? null,
            ),
            addToCache: jest.fn(async (key: string, value: unknown) => {
                store.set(key, value);
            }),
        };
        const codeManagementService = {
            getRepositoryAllFiles: jest
                .fn()
                .mockResolvedValue([{ path: 'CLAUDE.md' }]),
            getRepositoryContentFile: jest.fn().mockResolvedValue({
                data: { content: 'Amounts are integer cents.' },
            }),
            getPullRequest: jest.fn().mockResolvedValue(null),
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
            undefined,
            undefined,
            undefined,
            cacheService as any,
        );
        return { stage, codeManagementService };
    };
    const withBase = (sha?: string) => ({
        ...context,
        pullRequest: {
            ...context.pullRequest,
            base: { ref: 'release/2.0', ...(sha ? { sha } : {}) },
        },
    });
    const resolve = (stage: AgentReviewStage, ctx: unknown) =>
        (stage as any).resolveRepoInstructions(
            ctx,
            [{ filename: 'src/a.ts' }],
            { kind: 'full' },
            7,
        );

    it('lists once per target-branch commit and still reads the files', async () => {
        const { stage, codeManagementService } = makeCachedStage();

        const first = await resolve(stage, withBase('abc'));
        const second = await resolve(stage, withBase('abc'));
        await resolve(stage, withBase('def'));

        expect(second.files).toEqual(first.files);
        expect(
            codeManagementService.getRepositoryAllFiles,
        ).toHaveBeenCalledTimes(2);
        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledTimes(3);
    });

    // GitLab's merge request and note payloads carry no target-branch commit,
    // so the pipeline's pull request has none; the provider's own PR has it.
    it('asks the provider for the target-branch commit when the payload has none', async () => {
        const { stage, codeManagementService } = makeCachedStage();
        codeManagementService.getPullRequest.mockResolvedValue({
            base: { ref: 'release/2.0', sha: 'abc' },
        });

        await resolve(stage, withBase());
        await resolve(stage, withBase());

        expect(
            codeManagementService.getRepositoryAllFiles,
        ).toHaveBeenCalledTimes(1);
        expect(codeManagementService.getPullRequest.mock.calls[0][0]).toEqual(
            expect.objectContaining({ prNumber: 7 }),
        );
    });

    it('does not ask the provider when the payload has the commit', async () => {
        const { stage, codeManagementService } = makeCachedStage();

        await resolve(stage, withBase('abc'));

        expect(codeManagementService.getPullRequest).not.toHaveBeenCalled();
    });

    it.each([
        ['has no commit for the target branch either', async () => ({ base: {} })],
        [
            'fails',
            async () => {
                throw new Error('502');
            },
        ],
    ])('lists every time when the provider %s', async (_label, impl) => {
        const { stage, codeManagementService } = makeCachedStage();
        codeManagementService.getPullRequest.mockImplementation(impl);

        const result = await resolve(stage, withBase());
        await resolve(stage, withBase());

        expect(result.files.map((f: { path: string }) => f.path)).toEqual([
            'CLAUDE.md',
        ]);
        expect(
            codeManagementService.getRepositoryAllFiles,
        ).toHaveBeenCalledTimes(2);
    });

    it('warns when the provider lookup fails', async () => {
        const { stage, codeManagementService } = makeCachedStage();
        codeManagementService.getPullRequest.mockRejectedValue(new Error('502'));
        const warn = jest.spyOn((stage as any).logger, 'warn');

        await resolve(stage, withBase());

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('commit lookup failed'),
            }),
        );
    });
});
