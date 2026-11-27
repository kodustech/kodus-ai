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
                        request: { url: '/user' },
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
const loggedFor = (...loggers: jest.Mock[]) =>
    JSON.stringify(
        loggers.flatMap((l) => l.mock.calls.map(([e]) => e.metadata)),
    );

const service = (Service: any) => {
    const svc: any = Object.create(Service.prototype);
    const error = jest.fn();
    const warn = jest.fn();
    svc.logger = { error, warn, log: jest.fn(), debug: jest.fn() };
    return { svc, error, warn };
};

describe.each([
    ['Bitbucket Cloud', BitbucketCloudService],
    ['Azure Repos', AzureReposService],
])('%s createAuthIntegration', (_name, Service: any) => {
    it('passes the token on and leaves the refusal to the link, which logs it', async () => {
        const { svc, error, warn } = service(Service);
        // Refuses only the PAT under test, as the provider would.
        svc.authenticateWithToken = jest.fn(async (p: { token: string }) => {
            if (p.token === PAT) {
                throw new BadRequestException('provider refused the token');
            }
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
        expect(error).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('authenticateWithToken logs a refused token as a warning, without it', () => {
    it('Bitbucket Cloud', async () => {
        const { svc, error, warn } = service(BitbucketCloudService);

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                username: 'dev',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(loggedFor(error, warn)).not.toContain(PAT);
    });

    it('Azure Repos', async () => {
        const { svc, error, warn } = service(AzureReposService);
        svc.checkRepositoryPermissions = jest.fn().mockRejectedValue(
            Object.assign(new Error('TF400813: not authorized'), {
                response: { status: 401 },
            }),
        );

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                orgUrl: 'https://dev.azure.example.test/acme',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(loggedFor(error, warn)).not.toContain(PAT);
    });

    it('Bitbucket Data Center', async () => {
        const { svc, error, warn } = service(BitbucketDataCenterService);
        svc.getAxiosInstance = jest.fn(() => ({
            get: jest.fn().mockRejectedValue(
                Object.assign(new Error('Unauthorized'), {
                    response: { status: 401 },
                }),
            ),
        }));

        await expect(
            svc.authenticateWithToken({
                organizationAndTeamData: ORG,
                token: PAT,
                host: 'https://bitbucket.example.test',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(loggedFor(error, warn)).not.toContain(PAT);
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
