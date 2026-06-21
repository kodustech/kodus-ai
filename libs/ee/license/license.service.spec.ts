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
