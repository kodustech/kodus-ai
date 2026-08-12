import { LicenseService } from './license.service';

/**
 * Cloud LicenseService.consumeTrialReviewCredit talks to the billing
 * microservice. These tests pin the error contract that the review pipeline
 * relies on:
 *   - a billing "allowed:false" body (e.g. credits exhausted) is PROPAGATED
 *     so the caller can surface the real reason, and
 *   - any other failure FAILS CLOSED (allowed:false) so a flaky billing call
 *     can never silently grant a free managed review.
 */
describe('LicenseService.consumeTrialReviewCredit', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const makeService = (post: jest.Mock) => {
        const service = new LicenseService();
        (service as any).licenseRequest = { post };
        return service;
    };

    it('returns the billing result and forwards org/team/usageKey on success', async () => {
        const billingResult = {
            allowed: true,
            trialReviewCreditsRemaining: 4,
            trialReviewCreditsUsed: 1,
        };
        const post = jest.fn().mockResolvedValue(billingResult);
        const service = makeService(post);

        const result = await service.consumeTrialReviewCredit(
            orgTeam,
            'repo-9:42',
        );

        expect(result).toEqual(billingResult);
        expect(post).toHaveBeenCalledWith('trial-review-credit/consume', {
            organizationId: 'org-1',
            teamId: 'team-1',
            usageKey: 'repo-9:42',
        });
    });

    it('propagates a billing allowed:false response (e.g. exhausted credits)', async () => {
        const denied = {
            allowed: false,
            reason: 'TRIAL_REVIEW_CREDITS_EXHAUSTED',
            trialReviewCreditsRemaining: 0,
        };
        const post = jest.fn().mockRejectedValue({ response: { data: denied } });
        const service = makeService(post);

        const result = await service.consumeTrialReviewCredit(orgTeam);

        expect(result).toEqual(denied);
    });

    it('fails closed when billing errors without an allowed:false body', async () => {
        const post = jest.fn().mockRejectedValue(new Error('network down'));
        const service = makeService(post);

        const result = await service.consumeTrialReviewCredit(orgTeam);

        expect(result).toEqual({
            allowed: false,
            reason: 'CONSUME_TRIAL_REVIEW_CREDIT_FAILED',
        });
    });
});

/**
 * startTrial provisions the org trial server-side (the browser used to be the
 * only caller). It must be idempotent and resilient: a 409 means the license
 * already exists (success), transient 5xx/network errors retry, and a
 * non-retriable client error gives up without looping.
 */
describe('LicenseService.startTrial', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const makeService = (post: jest.Mock) => {
        const service = new LicenseService();
        (service as any).licenseRequest = { post };
        return service;
    };

    it('provisions the trial and forwards org/team/byok on success', async () => {
        const post = jest.fn().mockResolvedValue({ id: 'trial-1' });
        const service = makeService(post);

        const result = await service.startTrial(orgTeam, true);

        expect(result).toBe(true);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith('trial', {
            organizationId: 'org-1',
            teamId: 'team-1',
            byok: true,
        });
    });

    it('treats a 409 (license already exists) as success without retrying', async () => {
        const post = jest
            .fn()
            .mockRejectedValue({ response: { status: 409 } });
        const service = makeService(post);

        const result = await service.startTrial(orgTeam, false);

        expect(result).toBe(true);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('gives up without retrying on a non-retriable client error', async () => {
        const post = jest
            .fn()
            .mockRejectedValue({ response: { status: 400 } });
        const service = makeService(post);

        const result = await service.startTrial(orgTeam, false);

        expect(result).toBe(false);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('retries transient 5xx failures and succeeds', async () => {
        jest.useFakeTimers();
        try {
            const post = jest
                .fn()
                .mockRejectedValueOnce({ response: { status: 503 } })
                .mockResolvedValueOnce({ id: 'trial-1' });
            const service = makeService(post);

            const promise = service.startTrial(orgTeam, false);
            await jest.advanceTimersByTimeAsync(1000);
            const result = await promise;

            expect(result).toBe(true);
            expect(post).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('returns false after exhausting retries on persistent failures', async () => {
        jest.useFakeTimers();
        try {
            const post = jest
                .fn()
                .mockRejectedValue({ response: { status: 500 } });
            const service = makeService(post);

            const promise = service.startTrial(orgTeam, false);
            await jest.advanceTimersByTimeAsync(5000);
            const result = await promise;

            expect(result).toBe(false);
            expect(post).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });
});

/**
 * Cloud seat revocation. Self-hosted flips a local flag, but the cloud seat
 * store lives in the billing microservice, so the only revoke channel is the
 * assign-license endpoint with an 'inactive' status.
 */
describe('LicenseService.unassignLicenses', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const makeService = (post: jest.Mock) => {
        const service = new LicenseService();
        (service as any).licenseRequest = { post };
        return service;
    };

    it('posts inactive assignments and reports the released seats', async () => {
        const post = jest
            .fn()
            .mockResolvedValue({ successful: [{ git_id: 'git-42' }] });
        const service = makeService(post);

        const result = await service.unassignLicenses(
            orgTeam,
            ['git-42'],
            'GITHUB',
        );

        expect(result).toEqual({ revoked: ['git-42'], failed: [] });
        expect(post).toHaveBeenCalledWith(
            'assign-license',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
                users: [
                    expect.objectContaining({
                        gitId: 'git-42',
                        licenseStatus: 'inactive',
                    }),
                ],
            }),
        );
    });

    // The billing service validates every user entry and 400s the whole request
    // when gitTool is missing ("Cada usuario deve ter gitId, gitTool e
    // licenseStatus"), so the provider must always be forwarded, lowercased to
    // match its GitTool enum.
    it('forwards the provider as a lowercased gitTool on every entry', async () => {
        const post = jest.fn().mockResolvedValue({ successful: [] });
        const service = makeService(post);

        await service.unassignLicenses(orgTeam, ['a', 'b'], 'GITHUB');

        const body = post.mock.calls[0][1];
        expect(body.users.map((u: any) => u.gitTool)).toEqual([
            'github',
            'github',
        ]);
    });

    // Billing reloads the org license, decrements its seat counter in memory
    // and saves the row once per request. Five concurrent single-seat revokes
    // left that counter at 3 instead of 0; the same five batched settled at 0.
    it('sends every seat in one request rather than one call per seat', async () => {
        const post = jest.fn().mockResolvedValue({
            successful: [{ git_id: 'a' }, { git_id: 'b' }, { git_id: 'c' }],
        });
        const service = makeService(post);

        await service.unassignLicenses(orgTeam, ['a', 'b', 'c'], 'github');

        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][1].users).toHaveLength(3);
    });

    it('reports seats billing did not release as failed', async () => {
        const post = jest
            .fn()
            .mockResolvedValue({ successful: [{ git_id: 'a' }] });
        const service = makeService(post);

        expect(
            await service.unassignLicenses(orgTeam, ['a', 'b'], 'github'),
        ).toEqual({ revoked: ['a'], failed: ['b'] });
    });

    it('fails every seat when the billing call throws', async () => {
        const post = jest.fn().mockRejectedValue(new Error('network down'));
        const service = makeService(post);

        expect(
            await service.unassignLicenses(orgTeam, ['a', 'b'], 'github'),
        ).toEqual({ revoked: [], failed: ['a', 'b'] });
    });

    it('short-circuits without calling billing for an empty list', async () => {
        const post = jest.fn();
        const service = makeService(post);

        expect(await service.unassignLicenses(orgTeam, [], 'github')).toEqual({
            revoked: [],
            failed: [],
        });
        expect(post).not.toHaveBeenCalled();
    });
});

describe('LicenseService.getAllUsersEverWithLicense', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

    const makeService = (get: jest.Mock) => {
        const service = new LicenseService();
        (service as any).licenseRequest = { get };
        return service;
    };

    // Billing's users-with-license filters on licenseStatus = ACTIVE and
    // returns bare { git_id } rows, so everything it reports is active and no
    // extra query param can surface revoked seats.
    it('marks every seat billing returns as active', async () => {
        const get = jest
            .fn()
            .mockResolvedValue([{ git_id: 'a' }, { git_id: 'b' }]);
        const service = makeService(get);

        expect(await service.getAllUsersEverWithLicense(orgTeam)).toEqual([
            { git_id: 'a', status: 'active' },
            { git_id: 'b', status: 'active' },
        ]);
        expect(get).toHaveBeenCalledWith('users-with-license', {
            params: { organizationId: 'org-1', teamId: 'team-1' },
        });
    });

    it('returns an empty list when the billing call fails', async () => {
        const get = jest.fn().mockRejectedValue(new Error('network down'));
        const service = makeService(get);

        expect(await service.getAllUsersEverWithLicense(orgTeam)).toEqual([]);
    });
});
