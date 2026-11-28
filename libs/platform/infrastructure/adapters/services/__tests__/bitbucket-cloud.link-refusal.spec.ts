import { BadRequestException, HttpException } from '@nestjs/common';

import { BitbucketCloudService } from '../bitbucket/bitbucket-cloud.service';

// Only the transport is replaced: the `bitbucket` client builds and throws
// its own HTTPError, so the shape the link reads is the library's, not a
// fixture's.
const mockFetch = jest.fn();
jest.mock('node-fetch', () => {
    const fn = (...args: unknown[]) => mockFetch(...args);
    return Object.assign(fn, { default: fn, __esModule: true });
});

const PAT = 'secret-pat-value';
const ORG = { organizationId: 'org-1', teamId: 't1' };

const answer = (status: number, statusText: string, body: unknown) => ({
    status,
    statusText,
    ok: status < 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
});

describe('Bitbucket Cloud link, through the real bitbucket client', () => {
    it('refuses a token Bitbucket rejects in words, from the HTTPError the client throws', async () => {
        mockFetch.mockResolvedValue(
            answer(401, 'Unauthorized', {
                type: 'error',
                error: { message: 'Invalid credentials' },
            }),
        );
        const svc: any = Object.create(BitbucketCloudService.prototype);
        svc.logger = { warn: jest.fn(), error: jest.fn() };

        const thrown = await svc
            .createAuthIntegration({
                authMode: 'token',
                token: PAT,
                username: 'dev',
                organizationAndTeamData: ORG,
            })
            .catch((e: unknown) => e);

        expect(mockFetch).toHaveBeenCalled();
        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as HttpException).message).toBe(
            'Bitbucket Cloud did not accept the credentials (401). Check the token and try again.',
        );
        // What lets the status count as the host's answer.
        const cause = (thrown as HttpException).cause as {
            name?: string;
            status?: number;
            request?: unknown;
        };
        expect(cause).toMatchObject({ name: 'HTTPError', status: 401 });
        expect(cause.request).toBeDefined();
        expect(svc.logger.error).not.toHaveBeenCalled();
        expect(svc.logger.warn).toHaveBeenCalledTimes(1);
        expect(svc.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Bitbucket Cloud integration refused',
                metadata: expect.objectContaining({
                    organizationAndTeamData: ORG,
                    reason: (thrown as HttpException).message,
                }),
            }),
        );
        expect(JSON.stringify(svc.logger.warn.mock.calls)).not.toContain(PAT);
    });
});
