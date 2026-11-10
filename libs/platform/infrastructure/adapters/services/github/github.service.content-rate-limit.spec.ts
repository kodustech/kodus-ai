jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import {
    ContentRateLimitGate,
    contentRateLimitGate,
    contentRateLimitKey,
} from './content-rate-limit-gate';
import { GithubService } from './github.service';

/**
 * Per-file content reads stop calling GitHub once it has answered "rate
 * limited until T" for the credential. Before, `getRepositoryContentFile`
 * swallowed the 403 and returned `undefined`, so a caller walking a big PR
 * fired head + base reads for every file anyway (~1,370 failing requests in
 * 30s on one production PR). The result for the caller is unchanged:
 * `undefined`, exactly what the failing request produced.
 */

const APP_INSTALL_1 = {
    org: 'acme',
    authMode: AuthMode.OAUTH,
    installationId: 'inst-1',
};
// What getPlatformAuthDetails returns for a PAT: the stored (encrypted)
// token plus the identity of its auth_integrations row.
const PAT_1 = {
    org: 'acme',
    authMode: AuthMode.TOKEN,
    authToken: 'encrypted-pat-value-1',
    authIntegrationId: 'auth-row-1',
    authUpdatedAt: new Date('2026-11-01T10:00:00.000Z'),
};
// Token rotated: same row, rewritten (TypeORM bumps updatedAt).
const PAT_1_ROTATED = {
    ...PAT_1,
    authToken: 'encrypted-pat-value-2',
    authUpdatedAt: new Date('2026-11-10T15:30:00.000Z'),
};

const primaryRateLimit = (resetInSeconds = 1200) =>
    Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(
                    Math.floor(Date.now() / 1000) + resetInSeconds,
                ),
            },
        },
    });

const secondaryRateLimit = (retryAfter = 60, status = 403) =>
    Object.assign(new Error('secondary rate limit'), {
        status,
        response: { status, headers: { 'retry-after': String(retryAfter) } },
    });

const forbidden = () =>
    Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
        response: { status: 403, headers: {} },
    });

const ok = { data: { content: 'ok' } };

/** Rate limited once, then every read succeeds. */
const limitedThenOk = () =>
    jest.fn().mockRejectedValueOnce(primaryRateLimit()).mockResolvedValue(ok);

describe('GithubService.getRepositoryContentFile — rate-limit gate', () => {
    const makeService = (
        getContent: jest.Mock,
        {
            cached = null,
            authDetail = APP_INSTALL_1,
        }: { cached?: unknown; authDetail?: Record<string, unknown> } = {},
    ) => {
        const service = new GithubService(
            { findOne: jest.fn() } as any,
            {} as any,
            { createOrUpdateConfig: jest.fn() } as any,
            {
                getFromCache: jest.fn().mockResolvedValue(cached),
                addToCache: jest.fn(),
            } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        const authSpy = jest
            .spyOn(service as any, 'getGithubAuthDetails')
            .mockResolvedValue(authDetail);
        const octokitSpy = jest
            .spyOn(service as any, 'instanceOctokit')
            .mockResolvedValue({ repos: { getContent } });
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, logger, authSpy, octokitSpy };
    };

    const read = (
        service: GithubService,
        filename = 'src/a.ts',
        org = 'org-1',
        sha?: string,
    ) =>
        service.getRepositoryContentFile({
            organizationAndTeamData: { organizationId: org, teamId: 'team-1' },
            repository: { id: '1', name: 'repo' },
            file: { filename, ...(sha ? { sha } : {}) },
            pullRequest: {
                number: 7,
                head: { ref: 'feat/x' },
                base: { ref: 'main' },
            },
        });

    beforeEach(() => {
        contentRateLimitGate.reset();
    });

    it('does not try the base ref when the head read is rate limited', async () => {
        const getContent = jest.fn().mockRejectedValue(primaryRateLimit());
        const { service } = makeService(getContent);

        await expect(read(service)).resolves.toBeUndefined();
        expect(getContent).toHaveBeenCalledTimes(1);
    });

    it('skips further reads inside the window without building a client, logging once', async () => {
        const getContent = jest.fn().mockRejectedValue(primaryRateLimit());
        const { service, logger, octokitSpy } = makeService(getContent);

        await read(service, 'src/a.ts');
        getContent.mockClear();
        octokitSpy.mockClear();
        logger.warn.mockClear();

        const results = await Promise.all(
            Array.from({ length: 50 }, (_, i) => read(service, `src/f${i}.ts`)),
        );

        expect(results.every((r) => r === undefined)).toBe(true);
        expect(getContent).not.toHaveBeenCalled();
        expect(octokitSpy).not.toHaveBeenCalled();
        const skipLogs = logger.warn.mock.calls.filter(([entry]) =>
            String(entry?.message).includes('skipping per-file content reads'),
        );
        expect(skipLogs).toHaveLength(1);
    });

    it('hands the loaded auth detail to the client instead of re-reading it', async () => {
        const { service, octokitSpy } = makeService(
            jest.fn().mockResolvedValue(ok),
        );

        await read(service);

        expect(octokitSpy).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            APP_INSTALL_1,
        );
    });

    it('keeps other tenants unaffected', async () => {
        const getContent = limitedThenOk();
        const { service } = makeService(getContent);

        await read(service, 'src/a.ts', 'org-1');
        await expect(read(service, 'src/a.ts', 'org-2')).resolves.toEqual(ok);
        expect(getContent).toHaveBeenCalledTimes(2);
    });

    it('still serves cache hits inside the window', async () => {
        const cachedValue = { data: { content: 'cached' } };
        const { service: limited } = makeService(
            jest.fn().mockRejectedValue(primaryRateLimit()),
        );
        await read(limited, 'src/a.ts');

        const { service } = makeService(jest.fn(), { cached: cachedValue });
        await expect(
            read(service, 'src/b.ts', 'org-1', 'blob-sha'),
        ).resolves.toEqual(cachedValue);
    });

    it('resumes reading after the window closes', async () => {
        jest.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
        try {
            const getContent = jest
                .fn()
                .mockRejectedValueOnce(secondaryRateLimit(60))
                .mockResolvedValue(ok);
            const { service } = makeService(getContent);

            await read(service, 'src/a.ts');
            await expect(read(service, 'src/b.ts')).resolves.toBeUndefined();
            expect(getContent).toHaveBeenCalledTimes(1);

            jest.setSystemTime(new Date('2026-11-10T12:01:01Z'));
            await expect(read(service, 'src/c.ts')).resolves.toEqual(ok);
            expect(getContent).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not gate a 403 that is not a rate limit (behaviour unchanged)', async () => {
        const getContent = jest.fn().mockRejectedValue(forbidden());
        const { service, logger } = makeService(getContent);

        await expect(read(service, 'src/a.ts')).resolves.toBeUndefined();
        // head + base, as before
        expect(getContent).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledTimes(1);

        getContent.mockClear();
        await read(service, 'src/b.ts');
        expect(getContent).toHaveBeenCalledTimes(2);
    });

    it('still logs the rate-limited read at error level, as the failed base read did', async () => {
        const getContent = jest.fn().mockRejectedValue(primaryRateLimit());
        const { service, logger } = makeService(getContent);

        await read(service);

        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    describe('credential identity (App installation or PAT)', () => {
        it.each([
            [
                'App reinstalled (new installation)',
                APP_INSTALL_1,
                { ...APP_INSTALL_1, installationId: 'inst-2' },
            ],
            ['PAT rotated (row rewritten)', PAT_1, PAT_1_ROTATED],
            [
                'PAT reconnected (new auth row)',
                PAT_1,
                { ...PAT_1, authIntegrationId: 'auth-row-2' },
            ],
            ['organization switched from App to PAT', APP_INSTALL_1, PAT_1],
        ])(
            '%s mid-window: the old credential stays gated, the new one reads',
            async (_label, before, after) => {
                const getContent = limitedThenOk();
                const { service, authSpy } = makeService(getContent, {
                    authDetail: before,
                });

                await read(service, 'src/a.ts');
                await expect(
                    read(service, 'src/b.ts'),
                ).resolves.toBeUndefined();
                expect(getContent).toHaveBeenCalledTimes(1);

                authSpy.mockResolvedValue(after);
                await expect(read(service, 'src/c.ts')).resolves.toEqual(ok);
                expect(getContent).toHaveBeenCalledTimes(2);
            },
        );

        it('never puts the token in a log line', async () => {
            const getContent = jest.fn().mockRejectedValue(primaryRateLimit());
            const { service, logger } = makeService(getContent, {
                authDetail: PAT_1,
            });

            await read(service, 'src/a.ts');
            await read(service, 'src/b.ts');

            const everything = JSON.stringify([
                logger.log.mock.calls,
                logger.warn.mock.calls,
                logger.error.mock.calls,
            ]);
            expect(everything).not.toContain(PAT_1.authToken);
        });

        it('records nothing when the credential could not be loaded', async () => {
            const getContent = jest.fn().mockResolvedValue(ok);
            const { service, authSpy } = makeService(getContent);

            authSpy.mockRejectedValueOnce(primaryRateLimit());
            await expect(read(service, 'src/a.ts')).resolves.toBeUndefined();

            await expect(read(service, 'src/b.ts')).resolves.toEqual(ok);
            expect(getContent).toHaveBeenCalledTimes(1);
        });
    });
});

describe('contentRateLimitKey', () => {
    const tenant = { organizationId: 'org-1', teamId: 'team-1' };

    it('keys a GitHub App by installation id', () => {
        expect(contentRateLimitKey(tenant, APP_INSTALL_1)).toBe(
            'org-1:team-1:app:inst-1',
        );
    });

    it('keys a PAT by its stored row and last write', () => {
        expect(contentRateLimitKey(tenant, PAT_1)).toBe(
            'org-1:team-1:token:auth-row-1:2026-11-01T10:00:00.000Z',
        );
    });

    it('uses nothing from the token: a different token on the same row write gives the same key', () => {
        // A full auth detail, as GithubService passes it (token included).
        const sameRowOtherToken = {
            ...PAT_1,
            authToken: 'something-else-entirely',
        };
        expect(contentRateLimitKey(tenant, sameRowOtherToken)).toBe(
            contentRateLimitKey(tenant, PAT_1),
        );
        expect(contentRateLimitKey(tenant, PAT_1)).not.toContain(
            PAT_1.authToken,
        );
    });

    it('treats the same instant as a Date or an ISO string alike', () => {
        expect(
            contentRateLimitKey(tenant, {
                ...PAT_1,
                authUpdatedAt: PAT_1.authUpdatedAt.toISOString(),
            }),
        ).toBe(contentRateLimitKey(tenant, PAT_1));
    });

    it('treats OAuth without an installation like instanceOctokit does (token path)', () => {
        expect(
            contentRateLimitKey(tenant, {
                authMode: AuthMode.OAUTH,
                authIntegrationId: 'auth-row-9',
                authUpdatedAt: '2026-11-02T00:00:00.000Z',
            }),
        ).toBe('org-1:team-1:token:auth-row-9:2026-11-02T00:00:00.000Z');
    });

    it('keeps teams of one organization apart', () => {
        expect(contentRateLimitKey(tenant, APP_INSTALL_1)).not.toBe(
            contentRateLimitKey(
                { organizationId: 'org-1', teamId: 'team-2' },
                APP_INSTALL_1,
            ),
        );
    });

    it('falls back to the tenant when no credential row is known', () => {
        const tokenWithoutRow = { authMode: AuthMode.TOKEN, authToken: 'x' };
        expect(contentRateLimitKey(tenant, tokenWithoutRow)).toBe(
            'org-1:team-1:unknown',
        );
        expect(contentRateLimitKey(tenant, null)).toBe('org-1:team-1:unknown');
        expect(contentRateLimitKey(undefined, undefined)).toBe(
            'no-org:no-team:unknown',
        );
    });
});

describe('ContentRateLimitGate', () => {
    // classifyGitHubError reads retry-after against the real clock, so the
    // injected clock starts from it.
    let now: number;
    const gate = () => new ContentRateLimitGate(() => now);

    beforeEach(() => {
        now = Date.now();
    });

    it('ignores errors that are not rate limits', () => {
        const g = gate();
        for (const error of [new Error('boom'), forbidden()]) {
            expect(g.isRateLimit(error)).toBe(false);
            g.record('t', error);
        }
        expect(g.blockedForMs('t')).toBe(0);
    });

    it('caps a far-future reset at one hour', () => {
        const g = gate();
        const farFuture = primaryRateLimit(86_400);
        expect(g.isRateLimit(farFuture)).toBe(true);
        g.record('t', farFuture);
        expect(g.blockedForMs('t')).toBeGreaterThan(0);
        expect(g.blockedForMs('t')).toBeLessThanOrEqual(60 * 60 * 1000);
    });

    it('opens again once the window has passed (429 retry-after)', () => {
        const g = gate();
        g.record('t', secondaryRateLimit(10, 429));
        expect(g.blockedForMs('t')).toBeGreaterThan(0);
        now += 10_001;
        expect(g.blockedForMs('t')).toBe(0);
    });

    it('sweeps expired windows of keys nobody reads again', () => {
        const g = gate();
        g.record('orphan', secondaryRateLimit(10));
        now += 10_001;
        g.record('other', primaryRateLimit(1200));
        expect((g as any).blockedUntil.has('orphan')).toBe(false);
        expect(g.blockedForMs('other')).toBeGreaterThan(0);
    });

    it('reports the first skip of each window only', () => {
        const g = gate();
        g.record('t', secondaryRateLimit(10));
        expect(g.firstSkipInWindow('t')).toBe(true);
        expect(g.firstSkipInWindow('t')).toBe(false);
    });
});
