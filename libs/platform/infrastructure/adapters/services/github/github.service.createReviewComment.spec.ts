import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Regression coverage: `createReviewCommentWithRetry`
 * (commentManager.service.ts) only retries with an adjusted single line when
 * `error.errorType === 'failed_lines_mismatch'` — set here from a substring
 * match on the GitHub error message. Two message shapes were covered
 * ("line must be part of the diff" / "start_line must be part of the same
 * hunk as the line"), but a THIRD, semantically identical GitHub validation
 * error was not: `Validation Failed:
 * {"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"could not be resolved"}`
 * (prod, 81 occurrences / 25 orgs). Falling through to the generic `'failed'`
 * errorType meant the retry-with-adjusted-line recovery never ran for this
 * shape, even though it is the exact class of error that recovery exists for.
 */
describe('GithubService.createReviewComment — line-mismatch classification', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { id: '1', name: 'repo' } as any;

    const makeService = (createReviewCommentImpl: () => Promise<never>) => {
        const service = new GithubService(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
            authMode: 'oauth',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            pulls: { createReviewComment: createReviewCommentImpl },
        });
        return service;
    };

    const call = (service: GithubService) =>
        service.createReviewComment({
            organizationAndTeamData,
            repository,
            prNumber: 1,
            lineComment: { path: 'src/x.ts', line: 10, body: 'x' },
            commit: { sha: 'abc' },
            language: 'en-US',
        });

    it("classifies GitHub's pull_request_review_thread.line 'could not be resolved' as failed_lines_mismatch", async () => {
        const service = makeService(() =>
            Promise.reject(
                new Error(
                    'Validation Failed: {"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"could not be resolved"} - https://docs.github.com/rest',
                ),
            ),
        );

        await expect(call(service)).rejects.toMatchObject({
            errorType: 'failed_lines_mismatch',
        });
    });

    it('still classifies the two previously-known line-mismatch messages the same way', async () => {
        const service1 = makeService(() =>
            Promise.reject(new Error('line must be part of the diff')),
        );
        await expect(call(service1)).rejects.toMatchObject({
            errorType: 'failed_lines_mismatch',
        });

        const service2 = makeService(() =>
            Promise.reject(
                new Error(
                    'start_line must be part of the same hunk as the line',
                ),
            ),
        );
        await expect(call(service2)).rejects.toMatchObject({
            errorType: 'failed_lines_mismatch',
        });
    });

    it('still classifies an unrelated error as the generic failed type', async () => {
        const service = makeService(() =>
            Promise.reject(new Error('Bad credentials')),
        );

        await expect(call(service)).rejects.toMatchObject({
            errorType: 'failed',
        });
    });
});
