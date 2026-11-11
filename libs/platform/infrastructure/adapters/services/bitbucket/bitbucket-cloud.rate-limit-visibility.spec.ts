jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (s: string) => s,
    encrypt: (s: string) => s,
}));

import { HttpStatus } from '@nestjs/common';

import { __resetRateGatesForTest } from '@libs/core/infrastructure/http/per-key-rate-gate';

import { BitbucketCloudService } from './bitbucket-cloud.service';

/**
 * A rate-limited Bitbucket account must be visible as such: in the logs,
 * tied to the organization, and in the repository listing, as a 429 instead
 * of an empty list.
 */

const org = { organizationId: 'org-1', teamId: 'team-1' };

function makeService(authDetails: any = { email: 'a@b.c', appPassword: 'p' }) {
    const integrationService = {
        findOne: jest.fn().mockResolvedValue({ uuid: 'integration-1' }),
        getPlatformAuthDetails: jest.fn().mockResolvedValue(authDetails),
    };
    const service = new BitbucketCloudService(
        integrationService as any,
        { findOne: jest.fn().mockResolvedValue(null) } as any,
        { findOne: jest.fn() } as any,
        { get: jest.fn() } as any,
    );
    const logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    (service as any).logger = logger;
    return { service, logger };
}

const respond = (status: number) =>
    new Response(status === 200 ? '{"values":[]}' : '', {
        status,
        headers: { 'content-type': 'application/json' },
    });

describe('BitbucketCloudService — rate limit visibility', () => {
    const realFetch = global.fetch;

    beforeEach(() => {
        __resetRateGatesForTest();
        jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        global.fetch = realFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('tags every 429 log with the organization and team of the credential', async () => {
        jest.useFakeTimers();
        global.fetch = jest.fn().mockResolvedValue(respond(429)) as any;
        const { service, logger } = makeService();

        const auth = await service.getAuthDetails(org);
        const api = (service as any).instanceBitbucketApi(auth);
        const call = api.user.get({}).catch(() => undefined);
        await jest.runAllTimersAsync();
        await call;

        const messages = logger.warn.mock.calls.map(([entry]) => entry);
        expect(messages.length).toBeGreaterThan(1);
        for (const entry of messages) {
            expect(entry.metadata).toMatchObject({
                organizationId: 'org-1',
                teamId: 'team-1',
            });
        }
        // the last retry is logged too, not only the waits before it
        expect(messages.at(-1).message).toMatch(/still rate limited/);
    });

    it('keeps the organization off the enumerable auth fields', async () => {
        const { service } = makeService();

        const auth = await service.getAuthDetails(org);

        expect(Object.keys(auth)).not.toContain('organizationId');
        expect(JSON.stringify(auth)).not.toContain('org-1');
    });

    it('answers the repository listing with a 429 when the workspaces read is rate limited', async () => {
        jest.useFakeTimers();
        global.fetch = jest.fn().mockResolvedValue(respond(429)) as any;
        const { service } = makeService();

        const listing = service
            .getRepositories({ organizationAndTeamData: org })
            .then(
                () => null,
                (error) => error,
            );
        await jest.runAllTimersAsync();
        const error = await listing;

        expect(error?.getStatus?.()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(error?.message).toMatch(/rate limiting/);
    });

    describe('a listing someone waits on (interactive)', () => {
        const listInteractive = (service: BitbucketCloudService) =>
            service
                .getRepositories({
                    organizationAndTeamData: org,
                    options: { interactive: true },
                })
                .then(
                    (repos) => ({ repos }),
                    (error) => ({ error }),
                );

        it('retries a 429 once after 20s, then gives the 429 back', async () => {
            jest.useFakeTimers();
            const fetchMock = jest.fn().mockResolvedValue(respond(429));
            global.fetch = fetchMock as any;
            const { service } = makeService();

            const listing = listInteractive(service);
            await jest.advanceTimersByTimeAsync(19_999);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1);
            const { error } = (await listing) as any;

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(error?.getStatus?.()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        });

        it('lists normally when the one retry succeeds', async () => {
            jest.useFakeTimers();
            const fetchMock = jest
                .fn()
                .mockResolvedValueOnce(respond(429))
                .mockResolvedValue(respond(200));
            global.fetch = fetchMock as any;
            const { service } = makeService();

            const listing = listInteractive(service);
            await jest.advanceTimersByTimeAsync(20_000);

            await expect(listing).resolves.toEqual({ repos: [] });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('keeps the full backoff for a listing nobody waits on', async () => {
            jest.useFakeTimers();
            const fetchMock = jest.fn().mockResolvedValue(respond(429));
            global.fetch = fetchMock as any;
            const { service } = makeService();

            const listing = service
                .getRepositories({ organizationAndTeamData: org })
                .catch(() => undefined);
            // 10s, then 20s: no give-up at the 20s mark
            await jest.advanceTimersByTimeAsync(29_999);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            await jest.runAllTimersAsync();
            await listing;
            expect(fetchMock).toHaveBeenCalledTimes(5);
        });
    });
});

describe('BitbucketCloudService — author scan paging', () => {
    it('stops paging a repository once a page reaches past the window', async () => {
        const { service } = makeService();
        const startDate = new Date('2026-09-01T00:00:00Z');
        const page = [
            { created_on: '2026-10-20T00:00:00Z', author: {} },
            { created_on: '2026-08-01T00:00:00Z', author: {} },
        ];
        const getNextPage = jest.fn();
        const list = jest.fn().mockResolvedValue({
            data: { values: page, next: 'https://next' },
        });
        (list as any).defaults = () => list;
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: 'repo-1', workspaceId: 'ws-1' }]);
        jest.spyOn(service as any, 'instanceBitbucketApi').mockReturnValue({
            pullrequests: { list },
            hasNextPage: () => true,
            getNextPage,
        });
        jest.spyOn(service as any, 'transformPullRequest').mockImplementation(
            (pr: any) => pr,
        );

        const prs = await service.getPullRequestsForAuthors({
            organizationAndTeamData: org,
            filters: { startDate, endDate: new Date('2026-11-01T00:00:00Z') },
        });

        expect(getNextPage).not.toHaveBeenCalled();
        expect(list.mock.calls[0][0]).toMatchObject({ pagelen: 50 });
        expect(prs).toHaveLength(1);
    });
});
