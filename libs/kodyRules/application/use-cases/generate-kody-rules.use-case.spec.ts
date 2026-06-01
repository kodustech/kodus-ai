import {
    GenerateKodyRulesUseCase,
    PR_FETCH_CONCURRENCY,
} from './generate-kody-rules.use-case';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GenerateKodyRulesUseCase.fetchPullRequestComments', () => {
    /**
     * Builds a codeManagementService stub that records how many calls are
     * in flight simultaneously, so the tests can assert real parallelism.
     */
    const buildCodeManagementMock = () => {
        let inFlight = 0;
        let maxInFlight = 0;

        const track =
            (resultFactory: (args: any) => unknown) =>
            async (args: any): Promise<unknown> => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await delay(15);
                inFlight--;
                return resultFactory(args);
            };

        return {
            getAllCommentsInPullRequest: jest.fn(
                track((a) => [`general-${a.prNumber}`]),
            ),
            getPullRequestReviewComment: jest.fn(
                track((a) => [`review-${a.filters.pullRequestNumber}`]),
            ),
            getFilesByPullRequestId: jest.fn(
                track((a) => [`file-${a.prNumber}`]),
            ),
            get maxInFlight() {
                return maxInFlight;
            },
        };
    };

    const buildUseCase = (codeManagementService: any) =>
        new GenerateKodyRulesUseCase(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // parametersService
            {} as any, // createOrUpdateParametersUseCase
            codeManagementService,
            {} as any, // commentAnalysisService
            {} as any, // moduleRef
            {} as any, // sendRulesNotificationUseCase
        );

    const repository = { id: 'repo-1', name: 'repo-1' } as any;
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const makePRs = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ pull_number: i + 1 }));

    it("collects each PR's comments, reviews and files, preserving order", async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);
        const prs = makePRs(6);

        const result = await (useCase as any).fetchPullRequestComments(
            repository,
            prs,
            orgTeam,
        );

        expect(result).toHaveLength(6);
        result.forEach((entry: any, i: number) => {
            expect(entry.pr).toBe(prs[i]);
            expect(entry.generalComments).toEqual([`general-${i + 1}`]);
            expect(entry.reviewComments).toEqual([`review-${i + 1}`]);
            expect(entry.files).toEqual([`file-${i + 1}`]);
        });
    });

    it('fetches in parallel, bounded by PR_FETCH_CONCURRENCY', async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);

        await (useCase as any).fetchPullRequestComments(
            repository,
            makePRs(20),
            orgTeam,
        );

        // The 3 calls per PR run together and multiple PRs overlap, so well
        // more than one request is in flight at a time...
        expect(cms.maxInFlight).toBeGreaterThan(3);
        // ...but never more than (PR concurrency × 3 calls per PR).
        expect(cms.maxInFlight).toBeLessThanOrEqual(PR_FETCH_CONCURRENCY * 3);
    });

    it('degrades a failed fetch to empty instead of aborting the batch', async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);
        const prs = makePRs(3);

        // PR #2's files fetch fails (e.g. a flaky Bitbucket 5xx).
        cms.getFilesByPullRequestId.mockImplementation(async (a: any) => {
            if (a.prNumber === 2) {
                throw new Error('bitbucket 500');
            }
            return [`file-${a.prNumber}`];
        });

        const result = await (useCase as any).fetchPullRequestComments(
            repository,
            prs,
            orgTeam,
        );

        // The batch is not aborted — all 3 PRs still come back.
        expect(result).toHaveLength(3);

        const pr2 = result.find((e: any) => e.pr.pull_number === 2);
        expect(pr2.files).toEqual([]); // failed fetch → empty fallback
        expect(pr2.generalComments).toEqual(['general-2']); // siblings unaffected

        const pr1 = result.find((e: any) => e.pr.pull_number === 1);
        expect(pr1.files).toEqual(['file-1']);
    });
});
