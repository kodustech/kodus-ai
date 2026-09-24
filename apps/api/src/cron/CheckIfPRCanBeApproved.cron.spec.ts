import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CheckIfPRCanBeApprovedCronProvider } from './CheckIfPRCanBeApproved.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

type Deps = {
    automationExecutionService: {
        findLatestExecutionByFilters: jest.Mock;
        find: jest.Mock;
    };
    codeManagementService: {
        getPullRequest: jest.Mock;
        getPullRequestReviewThreads: jest.Mock;
        getPullRequestReviewComments: jest.Mock;
        checkIfPullRequestShouldBeApproved: jest.Mock;
    };
    pullRequestMessagesService: {
        findOne: jest.Mock;
    };
};

function buildDeps(): Deps {
    return {
        automationExecutionService: {
            findLatestExecutionByFilters: jest.fn().mockResolvedValue(null),
            find: jest.fn().mockResolvedValue([]),
        },
        codeManagementService: {
            getPullRequest: jest.fn().mockResolvedValue(undefined),
            getPullRequestReviewThreads: jest.fn().mockResolvedValue([]),
            getPullRequestReviewComments: jest.fn().mockResolvedValue([]),
            checkIfPullRequestShouldBeApproved: jest
                .fn()
                .mockResolvedValue(undefined),
        },
        pullRequestMessagesService: {
            findOne: jest.fn().mockResolvedValue(null),
        },
    };
}

function buildProvider(deps: Deps): CheckIfPRCanBeApprovedCronProvider {
    return new CheckIfPRCanBeApprovedCronProvider(
        {} as any, // teamService
        {} as any, // parametersService
        {} as any, // pullRequestService
        {} as any, // codeBaseConfigService
        deps.codeManagementService as any,
        deps.automationExecutionService as any,
        {} as any, // automationService
        {} as any, // teamAutomationService
        deps.pullRequestMessagesService as any,
        {} as any, // distributedLockService
    );
}

const ORG_DATA = { organizationId: 'org-1', teamId: 'team-1' } as any;

function basePr(overrides: Record<string, any> = {}) {
    return {
        number: 7,
        provider: PlatformType.GITHUB,
        repository: { id: 'repo-1', name: 'repo-name' },
        ...overrides,
    };
}

describe('CheckIfPRCanBeApprovedCronProvider (deterministic logic)', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getLastAnalyzedCommitSha', () => {
        let provider: CheckIfPRCanBeApprovedCronProvider;

        beforeEach(() => {
            provider = buildProvider(buildDeps());
        });

        const call = (input?: any): string | null =>
            (provider as any).getLastAnalyzedCommitSha(input);

        it('returns null for undefined', () => {
            expect(call(undefined)).toBeNull();
        });

        it('returns null for null', () => {
            expect(call(null)).toBeNull();
        });

        it('returns null for the empty string (falsy guard)', () => {
            expect(call('')).toBeNull();
        });

        it('returns the string as-is when given a non-empty string', () => {
            expect(call('abc123')).toBe('abc123');
        });

        it('returns null for a number (neither string nor object branch)', () => {
            expect(call(123)).toBeNull();
        });

        it('returns null for an object with no known sha field', () => {
            expect(call({ foo: 'bar' })).toBeNull();
        });

        it('reads .sha from an object', () => {
            expect(call({ sha: 'sha-a' })).toBe('sha-a');
        });

        it('reads .commitSha when .sha is absent', () => {
            expect(call({ commitSha: 'sha-b' })).toBe('sha-b');
        });

        it('reads .commit.sha when .sha and .commitSha are absent', () => {
            expect(call({ commit: { sha: 'sha-c' } })).toBe('sha-c');
        });

        it('prefers .sha over .commitSha and .commit.sha', () => {
            expect(
                call({
                    sha: 'sha-a',
                    commitSha: 'sha-b',
                    commit: { sha: 'sha-c' },
                }),
            ).toBe('sha-a');
        });

        it('prefers .commitSha over .commit.sha when .sha is absent', () => {
            expect(
                call({ commitSha: 'sha-b', commit: { sha: 'sha-c' } }),
            ).toBe('sha-b');
        });
    });

    describe('hasInProgressReviewExecution', () => {
        const call = (deps: Deps, args: any): Promise<boolean> =>
            (buildProvider(deps) as any).hasInProgressReviewExecution(args);

        it('returns false and does not query when teamAutomationId is empty', async () => {
            const deps = buildDeps();
            const result = await call(deps, {
                teamAutomationId: '',
                pullRequestNumber: 7,
                repositoryId: 'repo-1',
            });
            expect(result).toBe(false);
            expect(deps.automationExecutionService.find).not.toHaveBeenCalled();
        });

        it('returns false and does not query when pullRequestNumber is not a number', async () => {
            const deps = buildDeps();
            const result = await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: '7' as any,
                repositoryId: 'repo-1',
            });
            expect(result).toBe(false);
            expect(deps.automationExecutionService.find).not.toHaveBeenCalled();
        });

        it('treats pullRequestNumber 0 as a valid number and queries', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue([]);
            const result = await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 0,
                repositoryId: 'repo-1',
            });
            expect(result).toBe(false);
            expect(deps.automationExecutionService.find).toHaveBeenCalledTimes(
                1,
            );
        });

        it('returns false for an empty result array (length 0 boundary)', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue([]);
            const result = await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 7,
            });
            expect(result).toBe(false);
        });

        it('returns true for exactly one in-progress execution (length 1 boundary)', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue([{ id: 1 }]);
            const result = await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 7,
            });
            expect(result).toBe(true);
        });

        it('returns false when the service returns a non-array', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue(null);
            const result = await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 7,
            });
            expect(result).toBe(false);
        });

        it('includes repositoryId in the filter and pins the IN_PROGRESS status', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue([]);
            await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 7,
                repositoryId: 'repo-1',
            });
            expect(deps.automationExecutionService.find).toHaveBeenCalledWith({
                teamAutomation: { uuid: 'ta-1' },
                pullRequestNumber: 7,
                repositoryId: 'repo-1',
                status: AutomationStatus.IN_PROGRESS,
            });
        });

        it('omits repositoryId from the filter when it is not provided', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.find.mockResolvedValue([]);
            await call(deps, {
                teamAutomationId: 'ta-1',
                pullRequestNumber: 7,
            });
            expect(deps.automationExecutionService.find).toHaveBeenCalledWith({
                teamAutomation: { uuid: 'ta-1' },
                pullRequestNumber: 7,
                status: AutomationStatus.IN_PROGRESS,
            });
            const filter =
                deps.automationExecutionService.find.mock.calls[0][0];
            expect('repositoryId' in filter).toBe(false);
        });
    });

    describe('shouldApprovePR', () => {
        const call = (deps: Deps, args: any): Promise<boolean> =>
            (buildProvider(deps) as any).shouldApprovePR(args);

        it('queries the latest SUCCESS execution with the exact filter', async () => {
            const deps = buildDeps();
            await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });
            expect(
                deps.automationExecutionService.findLatestExecutionByFilters,
            ).toHaveBeenCalledWith({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: 'ta-1' },
                pullRequestNumber: 7,
                repositoryId: 'repo-1',
            });
        });

        it('returns false and skips review lookup when a new commit exists since last review', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'sha-old' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'sha-new' },
            });

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).not.toHaveBeenCalled();
        });

        it('proceeds past the commit check when the head sha matches the last analyzed sha', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'sha-1' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { sha: 'sha-1' },
            });

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            // empty review threads -> false, but the review lookup DID run
            expect(result).toBe(false);
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).toHaveBeenCalledTimes(1);
        });

        it('reads the head sha from the headSha fallback field', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'sha-old' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                headSha: 'sha-new',
            });

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).not.toHaveBeenCalled();
        });

        it('reads the head sha from the head.commit.sha fallback field', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'sha-old' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({
                head: { commit: { sha: 'sha-new' } },
            });

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
        });

        it('does not fetch the current PR when there is no last analyzed commit', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                null,
            );

            await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(
                deps.codeManagementService.getPullRequest,
            ).not.toHaveBeenCalled();
        });

        it('proceeds when the current head sha is not resolvable (falsy head)', async () => {
            const deps = buildDeps();
            deps.automationExecutionService.findLatestExecutionByFilters.mockResolvedValue(
                { dataExecution: { lastAnalyzedCommit: 'sha-old' } },
            );
            deps.codeManagementService.getPullRequest.mockResolvedValue({});

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).toHaveBeenCalledTimes(1);
        });

        it('uses review THREADS for GitHub and not review comments', async () => {
            const deps = buildDeps();
            await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr({ provider: PlatformType.GITHUB }),
                teamAutomationId: 'ta-1',
            });
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).toHaveBeenCalledTimes(1);
            expect(
                deps.codeManagementService.getPullRequestReviewComments,
            ).not.toHaveBeenCalled();
        });

        it('uses review COMMENTS for non-GitHub providers', async () => {
            const deps = buildDeps();
            await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr({ provider: PlatformType.GITLAB }),
                teamAutomationId: 'ta-1',
            });
            expect(
                deps.codeManagementService.getPullRequestReviewComments,
            ).toHaveBeenCalledTimes(1);
            expect(
                deps.codeManagementService.getPullRequestReviewThreads,
            ).not.toHaveBeenCalled();
        });

        it('returns false when there are no review comments', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [],
            );
            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });
            expect(result).toBe(false);
        });

        it('approves when every review comment is resolved and no review is in progress', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [{ fullDatabaseId: 1, isResolved: true }],
            );
            deps.automationExecutionService.find.mockResolvedValue([]);

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(true);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).toHaveBeenCalledTimes(1);
        });

        it('returns undefined (no approval) when not every review comment is resolved', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [
                    { fullDatabaseId: 1, isResolved: true },
                    { fullDatabaseId: 2, isResolved: false },
                ],
            );

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBeUndefined();
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
        });

        it('returns false without approving when a review is in progress despite all comments resolved', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [{ fullDatabaseId: 1, isResolved: true }],
            );
            deps.automationExecutionService.find.mockResolvedValue([
                { id: 'exec-1' },
            ]);

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
        });

        it('returns false when the review lookup throws (fail-safe catch)', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockRejectedValue(
                new Error('provider down'),
            );

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
        });

        it('keeps only CODE-type comments for Azure Repos', async () => {
            const deps = buildDeps();
            // Azure uses getPullRequestReviewComments; the text comment is
            // unresolved and must be filtered out so approval can still happen.
            deps.codeManagementService.getPullRequestReviewComments.mockResolvedValue(
                [
                    { commentType: 'codeChange', isResolved: true },
                    { commentType: 'text', isResolved: false },
                ],
            );
            deps.automationExecutionService.find.mockResolvedValue([]);

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr({ provider: PlatformType.AZURE_REPOS }),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(true);
        });

        it('filters review comments to those matching delivered suggestions (GitHub id + fullDatabaseId)', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [
                    { fullDatabaseId: 100, isResolved: true },
                    { id: 'c2', isResolved: true },
                    // unmatched + unresolved: must be filtered out, else approval fails
                    { fullDatabaseId: 999, isResolved: false },
                    // no id at all: must be filtered out
                    { isResolved: false },
                ],
            );
            deps.automationExecutionService.find.mockResolvedValue([]);

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr({
                    suggestions: [
                        { comment: { id: 100 } },
                        { comment: { id: 'c2' } },
                    ],
                }),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(true);
        });

        it('returns false when no review comment matches any delivered suggestion', async () => {
            const deps = buildDeps();
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [{ fullDatabaseId: 'y', isResolved: true }],
            );

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr({ suggestions: [{ comment: { id: 'x' } }] }),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(false);
            expect(
                deps.codeManagementService.checkIfPullRequestShouldBeApproved,
            ).not.toHaveBeenCalled();
        });

        it('strips start/end review message comments before evaluating resolution', async () => {
            const deps = buildDeps();
            deps.pullRequestMessagesService.findOne.mockResolvedValue({
                startReviewMessage: { content: 'START' },
                endReviewMessage: { content: 'END' },
            });
            deps.codeManagementService.getPullRequestReviewThreads.mockResolvedValue(
                [
                    // unresolved bot messages that must be stripped
                    { body: 'START', isResolved: false },
                    { body: 'END', isResolved: false },
                    // real, resolved comment that remains
                    { body: 'real feedback', isResolved: true },
                ],
            );
            deps.automationExecutionService.find.mockResolvedValue([]);

            const result = await call(deps, {
                organizationAndTeamData: ORG_DATA,
                pr: basePr(),
                teamAutomationId: 'ta-1',
            });

            expect(result).toBe(true);
        });
    });
});
