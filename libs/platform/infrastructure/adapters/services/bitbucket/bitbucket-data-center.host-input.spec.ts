import { BadRequestException } from '@nestjs/common';
import axios from 'axios';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { BitbucketDataCenterService } from './bitbucket-data-center.service';

jest.mock('../git-server-url.guard', () => ({
    ...jest.requireActual('../git-server-url.guard'),
    assertGitServerUrlAllowed: jest.fn().mockResolvedValue(undefined),
}));

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

/** The service without its constructor: only what a test hands it. */
const make = () => {
    const service = Object.create(BitbucketDataCenterService.prototype) as any;
    const values = {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        addAccessToken: jest.fn().mockResolvedValue({}),
    };
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(service, key, { value, writable: true });
    }
    return service;
};

// Setup and the update-token modal both reach the host through here.
const connect = (service: any, host: string) =>
    service.createAuthIntegration({
        organizationAndTeamData,
        token: 'pat',
        host,
        authMode: AuthMode.TOKEN,
    });

describe('BitbucketDataCenterService host input', () => {
    let create: jest.SpyInstance;

    beforeEach(() => {
        create = jest.spyOn(axios, 'create').mockReturnValue({
            get: jest.fn().mockResolvedValue({
                status: 200,
                data: { values: [] },
                headers: { 'x-auserid': '1' },
            }),
        } as any);
    });

    afterEach(() => jest.restoreAllMocks());

    it.each(['bitbucket.acme.internal', '  bitbucket.acme.internal  '])(
        'refuses %p, a host without a scheme, with a 400 asking for https://',
        async (host) => {
            const service = make();
            const error = await connect(service, host).catch((e) => e);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.message).toBe(
                'Include https:// in the Bitbucket Data Center URL, for example https://bitbucket.example.com.',
            );
            expect(create).not.toHaveBeenCalled();
            expect(service.addAccessToken).not.toHaveBeenCalled();
        },
    );

    it.each([
        [
            '  https://bitbucket.acme.internal  ',
            'https://bitbucket.acme.internal',
        ],
        ['https://acme.internal/bitbucket', 'https://acme.internal/bitbucket'],
        [
            ' https://acme.internal/bitbucket/ ',
            'https://acme.internal/bitbucket/',
        ],
    ])('connects %p and stores it trimmed', async (host, stored) => {
        const service = make();

        await expect(connect(service, host)).resolves.toEqual({
            success: true,
            status: 'SUCCESS',
        });
        // The rest of the client config (auth header, address guard) is
        // covered elsewhere; this test owns the address the client targets.
        expect(create.mock.calls.map(([config]) => config.baseURL)).toEqual([
            `${stored.replace(/\/+$/, '')}/rest/api/1.0`,
        ]);
        expect(
            service.addAccessToken.mock.calls.map(([, auth]) => auth.host),
        ).toEqual([stored]);
    });
});
