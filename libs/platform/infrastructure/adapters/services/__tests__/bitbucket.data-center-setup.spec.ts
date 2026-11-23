import { BadRequestException } from '@nestjs/common';
import axios from 'axios';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { BitbucketService } from '../bitbucket.service';
import { BitbucketCloudService } from '../bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from '../bitbucket/bitbucket-data-center.service';

const ORG = { organizationId: 'org-1', teamId: 't1' };
const HOST = 'https://bitbucket.example.test';

/** The facade, with its two implementations and the stored-auth lookup stubbed. */
const facade = (storedAuth: any, storedAuthThrows = false) => {
    const svc: any = Object.create(BitbucketService.prototype);
    svc.bitbucketCloudService = {
        createAuthIntegration: jest.fn(async () => ({
            success: true,
            impl: 'cloud',
        })),
    };
    svc.bitbucketDataCenterService = {
        createAuthIntegration: jest.fn(async () => ({
            success: true,
            impl: 'data-center',
        })),
    };
    svc.integrationService = {
        getPlatformAuthDetails: jest.fn(async () => {
            if (storedAuthThrows) throw new Error('no integration');
            return storedAuth;
        }),
    };
    return svc;
};

describe('BitbucketService.createAuthIntegration', () => {
    it('runs a first-time Data Center setup on the Data Center implementation', async () => {
        // The reported case: nothing is stored yet, and the request carries the
        // host the user typed into the setup form.
        const svc = facade(undefined);

        const result = await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.BASIC,
            token: 'app-password',
            username: 'acme',
            host: HOST,
        });

        expect(
            svc.bitbucketDataCenterService.createAuthIntegration,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ host: HOST, authMode: AuthMode.BASIC }),
        );
        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, impl: 'data-center' });
    });

    it('does not need the stored-auth lookup when the request names a host', async () => {
        const svc = facade(undefined);

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.BASIC,
            token: 'app-password',
            host: HOST,
        });

        expect(
            svc.integrationService.getPlatformAuthDetails,
        ).not.toHaveBeenCalled();
    });

    it('keeps a Cloud setup on Cloud', async () => {
        const svc = facade({ host: '' });

        const result = await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
            email: 'acme@example.test',
        });

        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).toHaveBeenCalled();
        expect(
            svc.bitbucketDataCenterService.createAuthIntegration,
        ).not.toHaveBeenCalled();
        expect(result).toEqual({ success: true, impl: 'cloud' });
    });

    it('lets a submitted host win over a stored Cloud setup', async () => {
        // The case the routing change is about: the integration row says
        // Cloud (`host: ''`) because it was saved that way, and the setup form
        // now submits a Data Center host. The request decides.
        const svc = facade({ host: '' });

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.BASIC,
            token: 'app-password',
            username: 'acme',
            host: HOST,
        });

        expect(
            svc.bitbucketDataCenterService.createAuthIntegration,
        ).toHaveBeenCalledWith(expect.objectContaining({ host: HOST }));
        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).not.toHaveBeenCalled();
    });

    it('keeps an already connected Data Center host on Data Center', async () => {
        const svc = facade({ host: HOST });

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
        });

        expect(
            svc.bitbucketDataCenterService.createAuthIntegration,
        ).toHaveBeenCalled();
        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).not.toHaveBeenCalled();
    });

    it('leaves a failing stored-auth lookup on Cloud, as before', async () => {
        const svc = facade(undefined, true);

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
        });

        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).toHaveBeenCalled();
        expect(
            svc.bitbucketDataCenterService.createAuthIntegration,
        ).not.toHaveBeenCalled();
    });

    it('ignores a blank host and stays on Cloud', async () => {
        const svc = facade(undefined);

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
            host: '   ',
        });

        expect(
            svc.bitbucketCloudService.createAuthIntegration,
        ).toHaveBeenCalled();
    });
});

describe('BitbucketCloudService.createAuthIntegration', () => {
    const cloud = () => {
        const svc: any = Object.create(BitbucketCloudService.prototype);
        svc.logger = {
            error: jest.fn(),
            warn: jest.fn(),
            log: jest.fn(),
            debug: jest.fn(),
        };
        svc.authenticateWithToken = jest.fn(async () => ({ success: true }));
        svc.mcpManagerService = { createKodusMCPIntegration: jest.fn() };
        return svc;
    };

    it('refuses a Basic request instead of reporting success', async () => {
        const svc = cloud();

        await expect(
            svc.createAuthIntegration({
                organizationAndTeamData: ORG,
                authMode: AuthMode.BASIC,
                token: 'app-password',
                username: 'acme',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(svc.authenticateWithToken).not.toHaveBeenCalled();
    });

    it('still authenticates a token request', async () => {
        const svc = cloud();

        const result = await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
        });

        expect(svc.authenticateWithToken).toHaveBeenCalled();
        expect(result).toEqual({ success: true });
    });

    it('refuses a token request with no token instead of reporting success', async () => {
        const svc = cloud();

        await expect(
            svc.createAuthIntegration({
                organizationAndTeamData: ORG,
                authMode: AuthMode.TOKEN,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(svc.authenticateWithToken).not.toHaveBeenCalled();
    });
});

describe('BitbucketDataCenterService.createAuthIntegration', () => {
    const dataCenter = () => {
        const svc: any = Object.create(BitbucketDataCenterService.prototype);
        svc.logger = {
            error: jest.fn(),
            warn: jest.fn(),
            log: jest.fn(),
            debug: jest.fn(),
        };
        svc.integrationService = {
            findOne: jest.fn(async () => null),
        };
        svc.addAccessToken = jest.fn(async () => ({}));
        return svc;
    };

    afterEach(() => jest.restoreAllMocks());

    it('probes the repository list the setup reads next, not the project list', async () => {
        const svc = dataCenter();
        const get = jest.fn(async () => ({
            status: 200,
            data: { values: [] },
        }));
        const create = jest
            .spyOn(axios, 'create')
            .mockReturnValue({ get } as any);

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.TOKEN,
            token: 'pat',
            host: HOST,
        });

        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: `${HOST}/rest/api/1.0`,
            }),
        );
        expect(get).toHaveBeenCalledWith('/repos?limit=1');
        expect(svc.addAccessToken).toHaveBeenCalled();
    });

    it('refuses a probe that does not answer 200', async () => {
        const svc = dataCenter();
        const get = jest.fn(async () => ({ status: 401 }));
        jest.spyOn(axios, 'create').mockReturnValue({ get } as any);

        await expect(
            svc.createAuthIntegration({
                organizationAndTeamData: ORG,
                authMode: AuthMode.TOKEN,
                token: 'pat',
                host: HOST,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        // The old probe called /projects?limit=1: the URL is what pins the fix.
        expect(get).toHaveBeenCalledWith('/repos?limit=1');
        expect(svc.addAccessToken).not.toHaveBeenCalled();
    });

    it('refuses a 200 that is a login page, not a repository page', async () => {
        const svc = dataCenter();
        // An SSO in front of Bitbucket answers the API path with its own page:
        // status 200 and HTML, no pagination envelope.
        const get = jest.fn(async () => ({
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: '<!DOCTYPE html><html><body>Sign in</body></html>',
        }));
        jest.spyOn(axios, 'create').mockReturnValue({ get } as any);

        await expect(
            svc.createAuthIntegration({
                organizationAndTeamData: ORG,
                authMode: AuthMode.TOKEN,
                token: 'pat',
                host: HOST,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(svc.addAccessToken).not.toHaveBeenCalled();
    });

    it('accepts a valid page with no repositories', async () => {
        const svc = dataCenter();
        const get = jest.fn(async () => ({
            status: 200,
            data: { values: [], size: 0, isLastPage: true },
        }));
        jest.spyOn(axios, 'create').mockReturnValue({ get } as any);

        await expect(
            svc.createAuthIntegration({
                organizationAndTeamData: ORG,
                authMode: AuthMode.TOKEN,
                token: 'pat',
                host: HOST,
            }),
        ).resolves.toMatchObject({ success: true });

        // The pre-fix probe called /projects?limit=1: the URL is what pins
        // the fix, the empty page alone is accepted by both revisions.
        expect(get).toHaveBeenCalledWith('/repos?limit=1');
        expect(svc.addAccessToken).toHaveBeenCalled();
    });

    it('keeps the Basic request the setup form sends for a first-time connection', async () => {
        const svc = dataCenter();
        const get = jest.fn(async () => ({
            status: 200,
            data: { values: [] },
        }));
        const create = jest
            .spyOn(axios, 'create')
            .mockReturnValue({ get } as any);

        await svc.createAuthIntegration({
            organizationAndTeamData: ORG,
            authMode: AuthMode.BASIC,
            token: 'app-password',
            username: 'acme',
            host: HOST,
        });

        const basic = Buffer.from('acme:app-password').toString('base64');
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                baseURL: `${HOST}/rest/api/1.0`,
                headers: expect.objectContaining({
                    Authorization: `Basic ${basic}`,
                }),
            }),
        );
        expect(get).toHaveBeenCalledWith('/repos?limit=1');
        expect(svc.addAccessToken).toHaveBeenCalledWith(
            ORG,
            expect.objectContaining({ authMode: AuthMode.BASIC }),
        );
    });
});
