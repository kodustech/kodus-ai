import { BadRequestException } from '@nestjs/common';

import { GetWebhookCreationFailuresUseCase } from './get-webhook-creation-failures.use-case';

/**
 * The read this use case wraps is what the git settings page shows when a
 * webhook could not be created, so the two failure modes have to stay apart:
 * an invalid request is rejected, and only a genuine read failure degrades to
 * "no failures" (#2003 review).
 */
describe('GetWebhookCreationFailuresUseCase', () => {
    const ORG = { organizationId: 'org-1', teamId: 'team-1' };

    const build = (stored: unknown, rejects = false) => {
        const findIntegrationConfigFormatted = rejects
            ? jest.fn().mockRejectedValue(new Error('mongo down'))
            : jest.fn().mockResolvedValue(stored);

        const useCase = new GetWebhookCreationFailuresUseCase({
            findIntegrationConfigFormatted,
        } as any);

        return { useCase, findIntegrationConfigFormatted };
    };

    it('rejects a request with no tenant ids instead of reporting no failures', async () => {
        // Thrown inside the try, this rejection was folded into `{failures:{}}`
        // by the catch below it, so the caller read "nothing failed" where the
        // truth was "your request is invalid".
        const { useCase, findIntegrationConfigFormatted } = build({});

        await expect(
            useCase.execute({ organizationAndTeamData: undefined } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(findIntegrationConfigFormatted).not.toHaveBeenCalled();
    });

    it('rejects when only one of the two tenant ids is there', async () => {
        const { useCase } = build({});

        await expect(
            useCase.execute({
                organizationAndTeamData: { organizationId: 'org-1' },
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps a broken read a rejection, not an empty result', async () => {
        // An empty payload is the healthy answer this endpoint exists to
        // distinguish from a failure, so a read that breaks stays a 500 while
        // the validation above stays a 400 - the catch rethrows.
        const { useCase } = build(undefined, true);

        await expect(
            useCase.execute({ organizationAndTeamData: ORG } as any),
        ).rejects.toThrow('mongo down');
    });

    it('returns the recorded failures', async () => {
        const failures = { '11': { reason: 'HTTP 403', at: 'now' } };
        const { useCase } = build({ failures });

        await expect(
            useCase.execute({ organizationAndTeamData: ORG } as any),
        ).resolves.toEqual({ failures });
    });

    it('reads a record with no failures as an empty result', async () => {
        const { useCase } = build({ recordedAt: 'now' });

        await expect(
            useCase.execute({ organizationAndTeamData: ORG } as any),
        ).resolves.toEqual({ failures: {} });
    });
});
