import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { PullRequestsService } from './pullRequests.service';

/**
 * Regression test for issue #1045 / Bug C — race condition recovery.
 *
 * Two webhooks arriving inside the same second (`pullrequest.created`
 * + `pullrequest.updated`) both call `handleInitialPullRequest`. The
 * first wins the unique index `(number, repository.id, organizationId)`;
 * the second's `pullRequestsRepository.create` throws E11000.
 *
 * The catch block recovers by looking up the existing PR. Before the
 * fix it called `findByNumberAndRepositoryName` (`repository.name` is
 * mutable; Azure DevOps re-cases the name during repo lifecycle
 * events). When that lookup missed, the catch fell through, the error
 * was re-thrown, the review pipeline died, and the customer saw the
 * "👀 + nothing else" symptom from the bug report.
 *
 * The fix calls `findByNumberAndRepositoryId` — `repository.id` is the
 * exact column the unique index already enforced, so the lookup can
 * never miss for a real race.
 */
describe('PullRequestsService.handleInitialPullRequest — E11000 race recovery (issue #1045)', () => {
    let service: PullRequestsService;
    let pullRequestsRepository: {
        create: jest.Mock;
        findByNumberAndRepositoryId: jest.Mock;
        findByNumberAndRepositoryName: jest.Mock;
    };
    let codeManagement: any;

    const stubRepository = {
        id: 'repo-uuid-stable',
        name: 'kodus-app',
    };
    const stubOrg = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const fakeStructure = {
        // Just enough of the IPullRequests shape for `create()` to
        // accept it. The repository is mocked, so no schema validation
        // actually runs against this object.
        number: 42,
        repository: stubRepository,
        organizationId: stubOrg.organizationId,
        files: [],
    };

    const fakeExistingPR: any = {
        uuid: 'existing-pr-uuid',
        number: 42,
        repository: stubRepository,
        organizationId: stubOrg.organizationId,
    };

    beforeEach(() => {
        pullRequestsRepository = {
            create: jest.fn(),
            findByNumberAndRepositoryId: jest.fn(),
            findByNumberAndRepositoryName: jest.fn(),
        };
        codeManagement = {};

        service = new PullRequestsService(
            pullRequestsRepository as any,
            codeManagement,
        );

        // Stub the two private helpers `handleInitialPullRequest` runs
        // before reaching `create()` — we don't care what they do for
        // this regression, only that they don't error out.
        jest.spyOn(service as any, 'initializeCodeReviewStructure').mockResolvedValue(
            { ...fakeStructure },
        );
        jest.spyOn(service as any, 'addFilesToStructure').mockImplementation(
            async (s: any) => s,
        );
    });

    function makeE11000(): Error {
        const err: any = new Error(
            'E11000 duplicate key error collection: kodus.pullRequests index: number_1_repository.id_1_organizationId_1',
        );
        err.code = 11000;
        return err;
    }

    function makeMongoServerError(): Error {
        const err: any = new Error('Generic Mongo error');
        err.name = 'MongoServerError';
        return err;
    }

    function callHandleInitial(): Promise<any> {
        // `handleInitialPullRequest` is private — invoke via cast so we
        // exercise the catch block directly without spinning up the
        // full pipeline.
        return (service as any).handleInitialPullRequest(
            { number: 42 },
            stubRepository,
            [],
            [],
            [],
            PlatformType.AZURE_REPOS,
            stubOrg,
        );
    }

    it('returns the existing PR when E11000 fires and findByNumberAndRepositoryId resolves', async () => {
        pullRequestsRepository.create.mockRejectedValue(makeE11000());
        pullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
            fakeExistingPR,
        );

        const result = await callHandleInitial();

        expect(result).toBe(fakeExistingPR);
        expect(
            pullRequestsRepository.findByNumberAndRepositoryId,
        ).toHaveBeenCalledWith(42, stubRepository.id, stubOrg);
    });

    it('also recovers when the error has `name === "MongoServerError"` (no `code` field)', async () => {
        pullRequestsRepository.create.mockRejectedValue(makeMongoServerError());
        pullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
            fakeExistingPR,
        );

        const result = await callHandleInitial();

        expect(result).toBe(fakeExistingPR);
    });

    it('looks up by repository.id (NOT repository.name) — the column matching the unique index (anti-regression for #1045/2)', async () => {
        pullRequestsRepository.create.mockRejectedValue(makeE11000());
        pullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(
            fakeExistingPR,
        );

        await callHandleInitial();

        // The fix uses `findByNumberAndRepositoryId`. The bug was using
        // `findByNumberAndRepositoryName`. If anyone re-introduces the
        // name-based lookup in the catch block, this assertion fails.
        expect(
            pullRequestsRepository.findByNumberAndRepositoryName,
        ).not.toHaveBeenCalled();
        expect(
            pullRequestsRepository.findByNumberAndRepositoryId,
        ).toHaveBeenCalledTimes(1);
    });

    it('re-throws the original error when the fallback lookup also misses (non-recoverable case)', async () => {
        const e11000 = makeE11000();
        pullRequestsRepository.create.mockRejectedValue(e11000);
        // Fallback returns null (e.g. lookup raced, or different
        // `repository.id` between webhooks). We do NOT silently swallow
        // — the error propagates so the caller can fail loudly.
        pullRequestsRepository.findByNumberAndRepositoryId.mockResolvedValue(null);

        await expect(callHandleInitial()).rejects.toBe(e11000);
    });

    it('re-throws non-duplicate errors immediately, without consulting the lookup', async () => {
        const otherError = new Error('something else broke');
        pullRequestsRepository.create.mockRejectedValue(otherError);

        await expect(callHandleInitial()).rejects.toBe(otherError);
        expect(
            pullRequestsRepository.findByNumberAndRepositoryId,
        ).not.toHaveBeenCalled();
    });

    it('returns the freshly-created PR on the happy path (no race) — no fallback lookup', async () => {
        const fresh: any = { uuid: 'fresh-pr', ...fakeStructure };
        pullRequestsRepository.create.mockResolvedValue(fresh);

        const result = await callHandleInitial();

        expect(result).toBe(fresh);
        expect(
            pullRequestsRepository.findByNumberAndRepositoryId,
        ).not.toHaveBeenCalled();
    });
});
