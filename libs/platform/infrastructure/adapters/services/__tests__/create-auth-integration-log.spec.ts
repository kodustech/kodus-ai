import { BadRequestException } from '@nestjs/common';

import { AzureReposService } from '../azureRepos/azureRepos.service';
import { BitbucketCloudService } from '../bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from '../bitbucket/bitbucket-data-center.service';
import { GitlabService } from '../gitlab.service';

// Bitbucket Cloud's client: a token the API refuses, as Bitbucket does (401).
jest.mock('bitbucket', () => ({
    ...jest.requireActual('bitbucket'),
    Bitbucket: jest.fn().mockImplementation(({ auth }) => ({
        user: {
            get: jest.fn(async () => {
                if (auth.password === PAT) {
                    throw Object.assign(new Error('Unauthorized'), {
                        status: 401,
                    });
                }
                return { data: { username: 'acme' } };
            }),
        },
    })),
}));

const PAT = 'secret-pat-value';
const ORG = { organizationId: 'org-1', teamId: 't1' };

/**
 * A refused link is logged, and the request it logs carries the user's
 * personal access token: every provider logs named fields only.
 */
const loggedFor = (error: jest.Mock) =>
    JSON.stringify(error.mock.calls.map(([e]) => e.metadata));

const service = (Service: any) => {
    const svc: any = Object.create(Service.prototype);
    const error = jest.fn();
    svc.logger = { error, warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
    return { svc, error };
};

describe.each([
    ['Bitbucket Cloud', BitbucketCloudService],
    ['Azure Repos', AzureReposService],
])('%s createAuthIntegration', (_name, Service: any) => {
    it('logs a refused token without it, and passes the request on', async () => {
        const { svc, error } = service(Service);
        // Refuses only the PAT under test, as the provider would.
        svc.authenticateWithToken = jest.fn(async (p: { token: string }) => {
            if (p.token === PAT) throw new Error('provider refused the token');
            return { success: true };
        });

        await expect(
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                orgUrl: 'https://dev.azure.example.test/acme',
                organizationAndTeamData: ORG,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(svc.authenticateWithToken).toHaveBeenCalledWith(
            expect.objectContaining({
                token: PAT,
                organizationAndTeamData: ORG,
            }),
        );
        expect(error).toHaveBeenCalled();
        expect(loggedFor(error)).not.toContain(PAT);
        expect(error.mock.calls[0][0].metadata).toMatchObject({
            organizationAndTeamData: ORG,
            authMode: 'token',
        });
    });
});

describe('authenticateWithToken logs a refused token without it', () => {
    it('Bitbucket Cloud', async () => {
        const { svc, error } = service(BitbucketCloudService);

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                username: 'dev',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).toHaveBeenCalled();
        expect(loggedFor(error)).not.toContain(PAT);
    });

    it('Azure Repos', async () => {
        const { svc, error } = service(AzureReposService);
        svc.checkRepositoryPermissions = jest
            .fn()
            .mockRejectedValue(new Error('TF400813: not authorized'));

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                orgUrl: 'https://dev.azure.example.test/acme',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).toHaveBeenCalled();
        expect(loggedFor(error)).not.toContain(PAT);
    });

    it('Bitbucket Data Center', async () => {
        const { svc, error } = service(BitbucketDataCenterService);
        svc.getAxiosInstance = jest.fn(() => ({
            get: jest
                .fn()
                .mockRejectedValue(
                    Object.assign(new Error('Unauthorized'), { status: 401 }),
                ),
        }));

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                host: 'https://bitbucket.example.test',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).toHaveBeenCalled();
        expect(loggedFor(error)).not.toContain(PAT);
    });

    it('GitLab (repository check after the OAuth link)', async () => {
        const { svc, error } = service(GitlabService);
        svc.instanceGitlabApi = jest.fn(() => ({
            Projects: {
                all: jest.fn().mockRejectedValue(
                    Object.assign(new Error('401 Unauthorized'), {
                        status: 401,
                    }),
                ),
            },
        }));

        await expect(
            svc.checkRepositoryPermissions({
                authDetails: {
                    accessToken: PAT,
                    refreshToken: 'secret-refresh-token',
                    authMode: 'oauth',
                    host: 'https://gitlab.example.test',
                },
            }),
        ).resolves.toMatchObject({ success: false });

        expect(error).toHaveBeenCalled();
        expect(loggedFor(error)).not.toContain(PAT);
        expect(loggedFor(error)).not.toContain('secret-refresh-token');
        expect(error.mock.calls[0][0].metadata).toEqual({
            host: 'https://gitlab.example.test',
            authMode: 'oauth',
        });
    });
});
