import { BadRequestException, HttpException } from '@nestjs/common';
import axios from 'axios';

import { AzureReposService } from '../azureRepos/azureRepos.service';
import { BitbucketCloudService } from '../bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from '../bitbucket/bitbucket-data-center.service';
import { ForgejoService } from '../forgejo.service';
import { GitlabService } from '../gitlab.service';

const bitbucketUserGet = jest.fn();
jest.mock('bitbucket', () => ({
    ...jest.requireActual('bitbucket'),
    Bitbucket: jest.fn().mockImplementation(() => ({
        user: { get: (...args: unknown[]) => bitbucketUserGet(...args) },
    })),
}));

const PAT = 'secret-pat-value';
const ORG = { organizationId: 'org-1', teamId: 't1' };
const FAULT_MESSAGE = "Cannot read properties of null (reading 'id')";

const hostStatus = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status },
    });
const unreachable = () =>
    Object.assign(new Error('getaddrinfo ENOTFOUND git.example.test'), {
        code: 'ENOTFOUND',
    });

const service = (Service: any) => {
    const svc: any = Object.create(Service.prototype);
    svc.logger = {
        error: jest.fn(),
        warn: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
    };
    svc.integrationService = { findOne: jest.fn().mockResolvedValue(null) };
    return svc;
};

const logs = (svc: any) => [
    ...svc.logger.warn.mock.calls,
    ...svc.logger.error.mock.calls,
];

/** One way to drive each provider's link, and the hooks to make it fail. */
type Harness = {
    provider: string;
    make: () => any;
    link: (svc: any) => Promise<unknown>;
    /** Makes the first call to the host fail with `err`. */
    hostFails: (svc: any, err: Error) => void;
    /** Lets the host accept, then fails our own code after it. */
    faultAfterHost: (svc: any, err: Error) => void;
};

const harnesses: Harness[] = [
    {
        provider: 'GitLab',
        make: () => service(GitlabService),
        link: (svc) =>
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                host: 'https://git.example.test',
                organizationAndTeamData: ORG,
            }),
        hostFails: (_svc, err) => {
            jest.spyOn(axios, 'get').mockRejectedValueOnce(err);
        },
        faultAfterHost: (svc, err) => {
            jest.spyOn(axios, 'get').mockResolvedValueOnce({
                data: { id: 1 },
            });
            svc.checkRepositoryPermissions = jest
                .fn()
                .mockResolvedValue({ success: true });
            svc.integrationService.findOne.mockRejectedValue(err);
        },
    },
    {
        provider: 'Bitbucket Cloud',
        make: () => service(BitbucketCloudService),
        link: (svc) =>
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                username: 'dev',
                organizationAndTeamData: ORG,
            }),
        hostFails: (_svc, err) => {
            bitbucketUserGet.mockRejectedValueOnce(err);
        },
        faultAfterHost: (svc, err) => {
            bitbucketUserGet.mockResolvedValueOnce({
                status: 200,
                data: { username: 'dev' },
            });
            svc.checkRepositoryPermissions = jest
                .fn()
                .mockResolvedValue({ success: true });
            svc.integrationService.findOne.mockRejectedValue(err);
        },
    },
    {
        provider: 'Bitbucket Data Center',
        make: () => service(BitbucketDataCenterService),
        link: (svc) =>
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                host: 'https://bitbucket.example.test',
                organizationAndTeamData: ORG,
            }),
        hostFails: (svc, err) => {
            svc.getAxiosInstance = jest.fn(() => ({
                get: jest.fn().mockRejectedValue(err),
            }));
        },
        faultAfterHost: (svc, err) => {
            svc.getAxiosInstance = jest.fn(() => ({
                get: jest
                    .fn()
                    .mockResolvedValue({ status: 200, data: { values: [] } }),
            }));
            svc.integrationService.findOne.mockRejectedValue(err);
        },
    },
    {
        provider: 'Azure Repos',
        make: () => service(AzureReposService),
        link: (svc) =>
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                orgUrl: 'https://dev.azure.example.test/acme',
                orgName: 'acme',
                organizationAndTeamData: ORG,
            }),
        hostFails: (svc, err) => {
            svc.checkRepositoryPermissions = jest.fn().mockRejectedValue(err);
        },
        faultAfterHost: (svc, err) => {
            svc.checkRepositoryPermissions = jest
                .fn()
                .mockResolvedValue({ success: true });
            svc.integrationService.findOne.mockRejectedValue(err);
        },
    },
    {
        provider: 'Forgejo',
        make: () => service(ForgejoService),
        link: (svc) =>
            svc.createAuthIntegration({
                authMode: 'token',
                token: PAT,
                host: 'https://git.example.test',
                organizationAndTeamData: ORG,
            }),
        hostFails: (svc, err) => {
            svc.checkRepositoryPermissions = jest.fn().mockRejectedValue(err);
        },
        faultAfterHost: (svc, err) => {
            svc.checkRepositoryPermissions = jest
                .fn()
                .mockResolvedValue({ success: true });
            svc.integrationService.findOne.mockRejectedValue(err);
        },
    },
];

/**
 * A failed link answers in words (a refusal, or a host that refused or
 * could not be reached) or as a fault the exception filter answers 500;
 * never with a 400 carrying the raw error. One log per failure, without the
 * token.
 */
describe.each(harnesses)('$provider createAuthIntegration', (h) => {
    afterEach(() => {
        jest.restoreAllMocks();
        bitbucketUserGet.mockReset();
    });

    it('leaves a fault in our own code to the exception filter, logged once', async () => {
        const svc = h.make();
        const fault = new TypeError(FAULT_MESSAGE);
        h.faultAfterHost(svc, fault);

        const thrown = await h.link(svc).catch((e) => e);

        expect(thrown).toBe(fault);
        expect(svc.logger.warn).not.toHaveBeenCalled();
        expect(svc.logger.error).toHaveBeenCalledTimes(1);
        expect(svc.logger.error.mock.calls[0][0]).toMatchObject({
            message: `Failed to create ${h.provider} integration`,
            error: fault,
        });
        expect(JSON.stringify(logs(svc))).not.toContain(PAT);
    });

    it('refuses in words when the host does not accept the credentials', async () => {
        const svc = h.make();
        h.hostFails(svc, hostStatus(401));

        const thrown = await h.link(svc).catch((e) => e);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(
            `${h.provider} did not accept the credentials (401). Check the token and try again.`,
        );
        expect(svc.logger.error).not.toHaveBeenCalled();
        expect(svc.logger.warn).toHaveBeenCalledTimes(1);
        expect(svc.logger.warn.mock.calls[0][0]).toMatchObject({
            message: `${h.provider} integration refused`,
        });
        expect(JSON.stringify(logs(svc))).not.toContain(PAT);
    });

    it('refuses in words when the host cannot be reached', async () => {
        const svc = h.make();
        h.hostFails(svc, unreachable());

        const thrown = await h.link(svc).catch((e) => e);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(
            `Kodus could not reach the ${h.provider} host (ENOTFOUND). Check the URL and that the host is reachable from Kodus.`,
        );
    });
});

describe('refusals keep their own words', () => {
    it.each([
        [
            'Bitbucket Cloud without a token',
            () =>
                service(BitbucketCloudService).createAuthIntegration({
                    authMode: 'token',
                    organizationAndTeamData: ORG,
                }),
            'A token is required to connect Bitbucket Cloud',
        ],
        [
            'Bitbucket Cloud with a username and password',
            () =>
                service(BitbucketCloudService).createAuthIntegration({
                    authMode: 'basic',
                    organizationAndTeamData: ORG,
                }),
            'Bitbucket Cloud authenticates with a token, not a username and password',
        ],
        [
            'Bitbucket Cloud over OAuth',
            () =>
                service(BitbucketCloudService).createAuthIntegration({
                    authMode: 'oauth',
                    organizationAndTeamData: ORG,
                }),
            'Authenticating on Bitbucket via OAuth not implemented',
        ],
        [
            'Azure Repos over OAuth',
            () =>
                service(AzureReposService).createAuthIntegration({
                    authMode: 'oauth',
                    organizationAndTeamData: ORG,
                }),
            'Authenticating on Azure Devops Repos via OAuth not implemented',
        ],
        [
            'Bitbucket Data Center without a host',
            () =>
                service(BitbucketDataCenterService).createAuthIntegration({
                    authMode: 'token',
                    token: PAT,
                    organizationAndTeamData: ORG,
                }),
            'Host is required for Bitbucket Data Center.',
        ],
        [
            'Bitbucket Data Center answering with a login page',
            () => {
                const svc = service(BitbucketDataCenterService);
                svc.getAxiosInstance = jest.fn(() => ({
                    get: jest
                        .fn()
                        .mockResolvedValue({ status: 200, data: '<html>' }),
                }));
                return svc.createAuthIntegration({
                    authMode: 'token',
                    token: PAT,
                    host: 'https://bitbucket.example.test',
                    organizationAndTeamData: ORG,
                });
            },
            'Bitbucket Data Center failed to validate the provided token.',
        ],
        [
            'Forgejo without a host',
            () =>
                service(ForgejoService).createAuthIntegration({
                    token: PAT,
                    organizationAndTeamData: ORG,
                }),
            'Forgejo host URL is required',
        ],
        [
            'Forgejo without a token',
            () =>
                service(ForgejoService).createAuthIntegration({
                    host: 'https://git.example.test',
                    organizationAndTeamData: ORG,
                }),
            'Forgejo access token is required',
        ],
        [
            'GitLab with an empty answer to the token check',
            () => {
                jest.spyOn(axios, 'get').mockResolvedValueOnce({ data: '' });
                return service(GitlabService).createAuthIntegration({
                    authMode: 'token',
                    token: PAT,
                    organizationAndTeamData: ORG,
                });
            },
            'GitLab failed to validate the PAT.',
        ],
        [
            'Bitbucket Cloud with an empty answer to the token check',
            () => {
                bitbucketUserGet.mockResolvedValueOnce({ status: 200 });
                return service(BitbucketCloudService).createAuthIntegration({
                    authMode: 'token',
                    token: PAT,
                    username: 'dev',
                    organizationAndTeamData: ORG,
                });
            },
            'Bitbucket failed to validate the PAT.',
        ],
    ])('%s', async (_name, run, message) => {
        const thrown = await run().catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(message);
        jest.restoreAllMocks();
    });
});
