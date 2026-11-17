import { Test, TestingModule } from '@nestjs/testing';

import { OrganizationMemberListService } from '@libs/platform/application/services/organization-member-list.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CacheService } from '@libs/core/cache/cache.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { LICENSE_SERVICE_TOKEN } from '@libs/ee/license/interfaces/license.interface';

describe('OrganizationMemberListService', () => {
    let service: OrganizationMemberListService;
    let mockCodeManagementService: {
        getListMembers: jest.Mock;
        getPullRequestAuthors: jest.Mock;
        canFindRecentPullRequestAuthors: jest.Mock;
        findRecentPullRequestAuthors: jest.Mock;
    };
    let mockLicenseService: { getAllUsersWithLicense: jest.Mock };
    let mockCacheService: {
        getFromCache: jest.Mock;
        addToCache: jest.Mock;
        removeFromCache: jest.Mock;
    };

    const organizationAndTeamData = {
        organizationId: 'org-uuid-123',
        teamId: 'team-uuid-456',
    };

    beforeEach(async () => {
        mockCodeManagementService = {
            getListMembers: jest.fn(),
            getPullRequestAuthors: jest.fn().mockResolvedValue([]),
            canFindRecentPullRequestAuthors: jest.fn().mockResolvedValue(false),
            findRecentPullRequestAuthors: jest.fn().mockResolvedValue([]),
        };
        mockLicenseService = {
            getAllUsersWithLicense: jest.fn().mockResolvedValue([]),
        };

        mockCacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
            removeFromCache: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrganizationMemberListService,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: CacheService,
                    useValue: mockCacheService,
                },
                {
                    provide: LICENSE_SERVICE_TOKEN,
                    useValue: mockLicenseService,
                },
            ],
        }).compile();

        service = module.get(OrganizationMemberListService);
    });

    describe('when the provider answers', () => {
        it('returns the normalized members with an ok status', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 2, name: 'Bob' },
                { id: 1, name: 'Alice' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                complete: true,
                members: [
                    { id: 1, name: 'Alice', type: 'user' },
                    { id: 2, name: 'Bob', type: 'user' },
                ],
            });
        });

        it('deduplicates members by id, keeping the first occurrence', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 1, name: 'Alice Duplicate' },
                { id: 2, name: 'Bob' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toHaveLength(2);
            expect(result.members.find((m) => m.id === 1)?.name).toBe('Alice');
        });

        it('falls back through the provider-specific identity fields', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { descriptor: 'aad.abc', displayName: 'Azure Person' },
                { uuid: 'bb-1', login: 'bitbucket-person' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toEqual([
                { id: 'aad.abc', name: 'Azure Person', type: 'user' },
                { id: 'bb-1', name: 'bitbucket-person', type: 'user' },
            ]);
        });
    });

    // Every provider models membership differently and each of them misses
    // somebody who can still open a pull request — the owner of a personal
    // account with no organization, an outside collaborator, an app that
    // authors PRs. Unioning recent PR authors gives all providers the same
    // floor, so a seat can always be assigned to whoever triggers a review.
    describe('pull request author union', () => {
        it('includes an app author the member list never reports, so it can be granted a seat', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '99', name: 'ci-agent', type: 'bot' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                complete: true,
                members: [
                    { id: 1, name: 'Alice', type: 'user' },
                    { id: '99', name: 'ci-agent', type: 'bot' },
                ],
            });
            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                determineBots: true,
                requireLoaded: true,
            });
        });

        // GitLab only resolves whether a member is a bot when asked; without
        // the flag every GitLab bot comes back typed as a user, so it would
        // never get a badge nor be shielded from seat pruning.
        it('asks the provider to identify bots in the member list too', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);

            await service.fetch(organizationAndTeamData);

            expect(
                mockCodeManagementService.getListMembers,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                determineBots: true,
                requireComplete: true,
            });
        });

        it('carries the list when only the authors resolve — a personal account with no organization', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('account belongs to no organization'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '4242', name: 'personal-owner' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            // Shown, but incomplete: absence from it proves nothing.
            expect(result).toEqual({
                status: 'ok',
                complete: false,
                members: [{ id: '4242', name: 'personal-owner', type: 'user' }],
            });
        });

        it('stays ok when the author lookup fails but the members resolve', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('rate limited'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({
                status: 'ok',
                complete: false,
                members: [{ id: 1, name: 'Alice', type: 'user' }],
            });
        });

        it('keeps the member-list entry when both sources report the same person', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice Doe' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '1', name: 'alice' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result.members).toEqual([
                { id: 1, name: 'Alice Doe', type: 'user' },
            ]);
        });
    });

    describe('when the caller requires pull request authors', () => {
        it('is unavailable when the author lookup fails, even with members', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('Too Many Requests'),
            );

            const strict = await service.fetch(organizationAndTeamData, {
                requireAuthors: true,
            });
            const lenient = await service.fetch(organizationAndTeamData);

            expect(strict).toEqual({ status: 'unavailable', members: [] });
            expect(lenient).toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
            // Every caller asks for a trustworthy read; the page keeps the
            // other source as partial data instead of dropping it.
            expect(
                mockCodeManagementService.getPullRequestAuthors.mock.calls.map(
                    ([params]) => params.requireLoaded,
                ),
            ).toEqual([true, true]);
        });

        it('is unavailable when the member read fails, even with stored authors', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('Too Many Requests'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '7', name: 'Recent Author' },
            ]);

            const strict = await service.fetch(organizationAndTeamData, {
                requireAuthors: true,
            });
            const lenient = await service.fetch(organizationAndTeamData);

            expect(strict).toEqual({ status: 'unavailable', members: [] });
            expect(lenient).toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
            expect(
                mockCodeManagementService.getListMembers.mock.calls.map(
                    ([params]) => params.requireComplete,
                ),
            ).toEqual([true, true]);
        });

        it('stays ok when the lookup succeeds with no recent authors', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue(
                [],
            );

            const result = await service.fetch(organizationAndTeamData, {
                requireAuthors: true,
            });

            expect(result.status).toBe('ok');
            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalledWith(
                expect.objectContaining({ requireLoaded: true }),
            );
        });
    });

    describe('when the member list cannot be trusted', () => {
        it('reports unavailable when every source throws', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('token expired'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('token expired'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the members throw and no author is left to fall back on', async () => {
            mockCodeManagementService.getListMembers.mockRejectedValue(
                new Error('token expired'),
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the provider returns an empty list', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when the provider returns a non-array', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue(null);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });

        it('reports unavailable when every entry is missing an id or a name', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { name: 'No id at all' },
                { id: 7 },
                null,
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(result).toEqual({ status: 'unavailable', members: [] });
        });
    });

    // Listing pull request authors fans out one API request per configured
    // repository, and the prune cron sweeps every opted-in team on a schedule.
    // Uncached, that re-scans every repo's history on every run.
    describe('pull request author caching', () => {
        it('serves the authors from cache without calling the provider', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCacheService.getFromCache.mockResolvedValue([
                { id: '99', name: 'ci-agent', type: 'bot' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).not.toHaveBeenCalled();
            expect(result.members.map((m) => m.id)).toContain('99');
        });

        it('caches the authors it fetched on a miss', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '99', name: 'ci-agent', type: 'bot' },
            ]);

            await service.fetch(organizationAndTeamData);

            expect(mockCacheService.addToCache).toHaveBeenCalledWith(
                'org_member_pr_authors_v2_org-uuid-123_team-uuid-456',
                [{ id: '99', name: 'ci-agent', type: 'bot' }],
                10 * 60 * 1000,
            );
        });

        // "Refresh members" exists precisely to pick up somebody who just
        // appeared, so it must not be answered from a stale cache.
        it('bypasses and clears the cache when the caller forces a refresh', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue(
                [],
            );

            await service.fetch(organizationAndTeamData, { skipCache: true });

            expect(mockCacheService.getFromCache).not.toHaveBeenCalled();
            expect(mockCacheService.removeFromCache).toHaveBeenCalledWith(
                expect.stringContaining('org_member_pr_authors_v2_'),
            );
            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalled();
        });

        it('does not answer the read after a failed refresh from the authors cached before it', async () => {
            const cache = new Map<string, unknown>();
            mockCacheService.getFromCache.mockImplementation(async (key) =>
                cache.get(key),
            );
            mockCacheService.addToCache.mockImplementation(
                async (key, value) => {
                    cache.set(key, value);
                },
            );
            mockCacheService.removeFromCache.mockImplementation(async (key) => {
                cache.delete(key);
            });
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValueOnce(
                [{ id: 2, name: 'Bob' }],
            );
            await service.fetch(organizationAndTeamData);

            mockCodeManagementService.getPullRequestAuthors.mockRejectedValue(
                new Error('HTTP 429'),
            );
            const refreshed = await service.fetch(organizationAndTeamData, {
                skipCache: true,
            });
            const reread = await service.fetch(organizationAndTeamData);

            expect(refreshed).toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
            expect(reread).toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
        });

        // An empty author scan is indistinguishable from a transient one: the
        // GitHub adapter swallows per-repo failures and returns whatever it
        // collected. Serving that for the full TTL would drop PR-author-only
        // identities — outside collaborators above all — out of the member
        // union, and the prune cron reads their absence as "left the org".
        it('treats an empty cached author list as a miss and re-scans', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCacheService.getFromCache.mockResolvedValue([]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue([
                { id: '77', name: 'outside-collaborator' },
            ]);

            const result = await service.fetch(organizationAndTeamData);

            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalled();
            expect(result.members.map((m) => m.id)).toContain('77');
        });

        it('does not cache an empty author scan', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue(
                [],
            );

            await service.fetch(organizationAndTeamData);

            expect(mockCacheService.addToCache).not.toHaveBeenCalled();
        });

        it('still fetches when the cache read throws', async () => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCacheService.getFromCache.mockRejectedValue(
                new Error('redis down'),
            );
            mockCodeManagementService.getPullRequestAuthors.mockResolvedValue(
                [],
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(result.status).toBe('ok');
            expect(
                mockCodeManagementService.getPullRequestAuthors,
            ).toHaveBeenCalled();
        });
    });
    describe('unlisted seat holders', () => {
        beforeEach(() => {
            mockCodeManagementService.getListMembers.mockResolvedValue([
                { id: 1, name: 'Alice' },
            ]);
            mockCodeManagementService.canFindRecentPullRequestAuthors.mockResolvedValue(
                true,
            );
            mockLicenseService.getAllUsersWithLicense.mockResolvedValue([
                { git_id: '1' },
                { git_id: '8' },
                { git_id: '9' },
            ]);
        });

        it('lists a seat holder the provider confirms as a recent author', async () => {
            mockCodeManagementService.findRecentPullRequestAuthors.mockResolvedValue(
                [{ id: '8', name: 'Dana', type: 'user' }],
            );

            const result = await service.fetch(organizationAndTeamData);

            expect(
                mockCodeManagementService.findRecentPullRequestAuthors,
            ).toHaveBeenCalledWith({
                organizationAndTeamData,
                authorIds: ['8', '9'],
            });
            expect(result).toEqual({
                status: 'ok',
                complete: true,
                members: [
                    { id: 1, name: 'Alice', type: 'user' },
                    { id: '8', name: 'Dana', type: 'user' },
                ],
            });
        });

        it('reads the list as incomplete when the check fails', async () => {
            mockCodeManagementService.findRecentPullRequestAuthors.mockRejectedValue(
                new Error('HTTP 429'),
            );

            await expect(
                service.fetch(organizationAndTeamData),
            ).resolves.toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
            await expect(
                service.fetch(organizationAndTeamData, {
                    requireAuthors: true,
                }),
            ).resolves.toEqual({ status: 'unavailable', members: [] });
        });

        it('reads the list as incomplete when the seats cannot be read', async () => {
            mockLicenseService.getAllUsersWithLicense.mockRejectedValue(
                new Error('timeout'),
            );

            await expect(
                service.fetch(organizationAndTeamData),
            ).resolves.toEqual(
                expect.objectContaining({ status: 'ok', complete: false }),
            );
        });

        it('reads no seats for a provider that cannot check', async () => {
            mockCodeManagementService.canFindRecentPullRequestAuthors.mockResolvedValue(
                false,
            );

            await expect(
                service.fetch(organizationAndTeamData),
            ).resolves.toEqual(
                expect.objectContaining({ status: 'ok', complete: true }),
            );
            expect(
                mockLicenseService.getAllUsersWithLicense,
            ).not.toHaveBeenCalled();
        });
    });
});
