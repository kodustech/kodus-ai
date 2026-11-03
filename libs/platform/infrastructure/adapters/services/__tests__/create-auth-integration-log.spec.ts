import { BadRequestException } from '@nestjs/common';

import { AzureReposService } from '../azureRepos/azureRepos.service';
import { BitbucketCloudService } from '../bitbucket/bitbucket-cloud.service';

/**
 * A failed link is logged, and the request it logs carries the user's personal
 * access token: the log takes named fields only, as GitHub's does.
 */
describe.each([
    ['Bitbucket Cloud', BitbucketCloudService],
    ['Azure Repos', AzureReposService],
])('%s createAuthIntegration', (_name, Service: any) => {
    it('logs a failed link without the token', async () => {
        const svc: any = Object.create(Service.prototype);
        const error = jest.fn();
        svc.logger = { error, warn: jest.fn(), log: jest.fn() };
        svc.authenticateWithToken = jest
            .fn()
            .mockRejectedValue(new Error('provider refused the token'));

        await expect(
            svc.createAuthIntegration({
                authMode: 'token',
                token: 'secret-pat-value',
                orgUrl: 'https://dev.azure.example.test/acme',
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 't1',
                },
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        const logged = JSON.stringify(
            error.mock.calls.map(([e]) => e.metadata),
        );
        expect(error).toHaveBeenCalled();
        expect(logged).not.toContain('secret-pat-value');
        expect(error.mock.calls[0][0].metadata).toMatchObject({
            organizationAndTeamData: { organizationId: 'org-1', teamId: 't1' },
            authMode: 'token',
        });
    });
});
