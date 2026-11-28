import { BadRequestException, HttpException } from '@nestjs/common';
import { AddressInfo } from 'net';
import * as http from 'http';

import { GatewayAddressRefusedError } from '@libs/llm/gateway-address-guard';
import axios from 'axios';
import pino from 'pino';

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
/** axios's shape for a failed DNS lookup: the code, with its config and request. */
const unreachable = () =>
    Object.assign(new Error('getaddrinfo ENOTFOUND git.example.test'), {
        code: 'ENOTFOUND',
        config: {},
        request: {},
    });
/** pg's shape when the database refuses the pool: no HTTP client involved. */
const databaseDown = () =>
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
        code: 'ECONNREFUSED',
        syscall: 'connect',
        port: 5432,
    });

/** What the logger writes for an error, through its real serializer. */
const { deepSanitize } = jest.requireActual('@libs/core/log/logger') as {
    deepSanitize: (value: unknown) => unknown;
};
const serialized = (err: unknown) =>
    JSON.stringify(deepSanitize(pino.stdSerializers.err(err as Error)));

const ADDRESS_REFUSAL =
    'Git server host "git.example.test" resolves to a private or reserved address; the call was not sent.';
/** axios's shape when the address guard refuses the socket: request, no response. */
const addressRefused = () => {
    const refused = new GatewayAddressRefusedError(
        'git.example.test',
        '10.0.0.7',
        'Git server',
    );
    return Object.assign(new Error(refused.message), {
        code: refused.code,
        request: {},
        cause: refused,
    });
};

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
    /** The service's class name and the named fields its link logs. */
    context: string;
    metadata: Record<string, unknown>;
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
        context: 'GitlabService',
        metadata: {
            organizationAndTeamData: ORG,
            authMode: 'token',
            host: 'https://git.example.test',
        },
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
        context: 'BitbucketCloudService',
        metadata: { organizationAndTeamData: ORG, host: undefined },
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
        context: 'BitbucketDataCenterService',
        metadata: {
            organizationAndTeamData: ORG,
            host: 'https://bitbucket.example.test',
        },
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
        context: 'AzureReposService',
        metadata: {
            organizationAndTeamData: ORG,
            orgUrl: 'https://dev.azure.example.test/acme',
        },
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
        context: 'ForgejoService',
        metadata: {
            organizationAndTeamData: ORG,
            host: 'https://git.example.test',
        },
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
        expect(svc.logger.error.mock.calls[0][0]).toEqual({
            message: `Failed to create ${h.provider} integration`,
            context: h.context,
            error: fault,
            metadata: h.metadata,
        });
        expect(JSON.stringify(logs(svc))).not.toContain(PAT);
    });

    it('leaves a database connection failure after the host to the exception filter', async () => {
        const svc = h.make();
        const down = databaseDown();
        h.faultAfterHost(svc, down);

        const thrown = await h.link(svc).catch((e) => e);

        // Not "could not reach the host": the git host answered.
        expect(thrown).toBe(down);
        expect(svc.logger.warn).not.toHaveBeenCalled();
        expect(svc.logger.error.mock.calls).toEqual([
            [
                {
                    message: `Failed to create ${h.provider} integration`,
                    context: h.context,
                    error: down,
                    metadata: h.metadata,
                },
            ],
        ]);
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
        expect(svc.logger.warn.mock.calls[0][0]).toEqual({
            message: `${h.provider} integration refused`,
            context: h.context,
            metadata: {
                ...h.metadata,
                reason: `${h.provider} did not accept the credentials (401). Check the token and try again.`,
            },
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

    it('refuses in words when Kodus refuses the host address as it connects', async () => {
        const svc = h.make();
        h.hostFails(svc, addressRefused());

        const thrown = await h.link(svc).catch((e) => e);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(ADDRESS_REFUSAL);
        expect(svc.logger.error).not.toHaveBeenCalled();
        expect(svc.logger.warn.mock.calls).toEqual([
            [
                {
                    message: `${h.provider} integration refused`,
                    context: h.context,
                    metadata: { ...h.metadata, reason: ADDRESS_REFUSAL },
                },
            ],
        ]);
    });
});

describe('GitLab OAuth link', () => {
    const CODE = 'gl-oauth-code-0000';
    const SECRET = 'gloas-client-secret-0000';
    const saved = { ...process.env };
    let server: http.Server;
    // GitLab's answer to a wrong or rotated client secret, unless a test
    // sets another.
    let answer = { status: 401, body: { error: 'invalid_client' } };

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.writeHead(answer.status, {
                'content-type': 'application/json',
            });
            res.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const { port } = server.address() as AddressInfo;
        process.env.API_GITLAB_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`;
        process.env.GLOBAL_GITLAB_CLIENT_ID = 'gitlab-client-id';
        process.env.GLOBAL_GITLAB_CLIENT_SECRET = SECRET;
    });

    afterAll(async () => {
        process.env = saved;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    afterEach(() => {
        answer = { status: 401, body: { error: 'invalid_client' } };
    });

    const link = (svc: any) =>
        svc
            .createAuthIntegration({
                authMode: 'oauth',
                code: CODE,
                organizationAndTeamData: ORG,
            })
            .catch((e: unknown) => e);

    it('refuses in words a code GitLab no longer accepts (invalid_grant), logged as a warning', async () => {
        // A callback reloaded or opened late: the code expired or was used.
        answer = {
            status: 400,
            body: { error: 'invalid_grant' },
        };
        const svc = service(GitlabService);

        const thrown = await link(svc);

        const words =
            'GitLab did not accept the authorization. Start the GitLab connection again.';
        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(words);
        expect(svc.logger.error).not.toHaveBeenCalled();
        expect(svc.logger.warn.mock.calls).toEqual([
            [
                {
                    message: 'GitLab integration refused',
                    context: 'GitlabService',
                    metadata: {
                        organizationAndTeamData: ORG,
                        authMode: 'oauth',
                        host: undefined,
                        reason: words,
                    },
                },
            ],
        ]);
        expect(serialized(thrown)).not.toContain(CODE);
    });

    it('leaves any other 400 from the token exchange to the exception filter', async () => {
        answer = { status: 400, body: { error: 'invalid_request' } };
        const svc = service(GitlabService);

        const thrown = await link(svc);

        expect(axios.isAxiosError(thrown)).toBe(true);
        expect(svc.logger.warn).not.toHaveBeenCalled();
        expect(svc.logger.error).toHaveBeenCalledTimes(1);
    });

    it('treats a 401 to the token exchange as a fault in Kodus credentials, logged once without the code or the secret', async () => {
        const svc = service(GitlabService);

        const thrown = await svc
            .createAuthIntegration({
                authMode: 'oauth',
                code: CODE,
                organizationAndTeamData: ORG,
            })
            .catch((e: unknown) => e);

        expect(axios.isAxiosError(thrown)).toBe(true);
        expect(
            (thrown as { response?: { status?: number } }).response?.status,
        ).toBe(401);
        expect(svc.logger.warn).not.toHaveBeenCalled();
        expect(svc.logger.error.mock.calls).toEqual([
            [
                {
                    message: 'Failed to create GitLab integration',
                    context: 'GitlabService',
                    error: thrown,
                    metadata: {
                        organizationAndTeamData: ORG,
                        authMode: 'oauth',
                        host: undefined,
                    },
                },
            ],
        ]);
        // The exception filter logs the same error.
        const written = serialized(thrown);
        // The request is written, without its body.
        const { config } = JSON.parse(written) as {
            config: Record<string, unknown>;
        };
        expect(config.url).toBe(process.env.API_GITLAB_TOKEN_URL);
        expect(config.method).toBe('post');
        expect(config).not.toHaveProperty('data');
        expect(written).not.toContain(CODE);
        expect(written).not.toContain(SECRET);
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
