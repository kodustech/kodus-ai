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
