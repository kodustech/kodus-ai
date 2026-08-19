// See github.service.cache.spec.ts for why environment.ts is mocked here.
jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

/**
 * Member listing for PERSONAL GitHub accounts.
 *
 * On cloud the octokit is authenticated with a GitHub App *installation*
 * token, which cannot call `GET /user` — it answers 403 "Resource not
 * accessible by integration". The personal-account branch used to call
 * `users.getAuthenticated()`, so every personal-account org threw and the
 * PR Licenses page rendered zero assignable rows: a purchased seat could
 * never be assigned to anyone.
 */

describe('GithubService — getAllMembersByOrg', () => {
    const org = { organizationId: 'org-1', teamId: 'team-1' };

    const makeService = (
        authDetail: Record<string, unknown> | null,
        octokitOverrides?: {
            listMembers?: jest.Mock;
            getByUsername?: jest.Mock;
            getAuthenticated?: jest.Mock;
            paginate?: jest.Mock;
        },
    ) => {
        const cacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn().mockResolvedValue(undefined),
            removeFromCache: jest.fn(),
            clearCache: jest.fn(),
            cacheExists: jest.fn(),
            getMultipleFromCache: jest.fn(),
            deleteByKeyPattern: jest.fn(),
        };

        const service = new GithubService(
            { findOne: jest.fn() } as any,
            {} as any,
            { createOrUpdateConfig: jest.fn() } as any,
            cacheService as any,
            { get: jest.fn() } as unknown as ConfigService,
        );

        const listMembers = octokitOverrides?.listMembers ?? jest.fn();
        const getByUsername =
            octokitOverrides?.getByUsername ??
            jest.fn().mockResolvedValue({
                data: { id: 4242, login: 'personal-owner', type: 'User' },
            });
        const getAuthenticated = octokitOverrides?.getAuthenticated ?? jest.fn();

        const octokit = {
            rest: {
                orgs: { listMembers },
                users: { getByUsername, getAuthenticated },
            },
            paginate:
                octokitOverrides?.paginate ?? jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue(
            authDetail as any,
        );
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(octokit);

        return { service, octokit };
    };

    it('resolves the account owner by login for a personal account, without calling GET /user', async () => {
        const { service, octokit } = makeService({
            org: 'personal-owner',
            accountType: 'user',
        });

        const members = await service.getAllMembersByOrg(org);

        expect(members).toEqual([
            { id: 4242, login: 'personal-owner', type: 'User' },
        ]);
        expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
            username: 'personal-owner',
        });
        // An installation token gets 403 on this endpoint — it must never be reached.
        expect(octokit.rest.users.getAuthenticated).not.toHaveBeenCalled();
        expect(octokit.paginate).not.toHaveBeenCalled();
    });

    it('falls back to the personal-account path when a legacy integration has no accountType and the org lookup 404s', async () => {
        const notFound: Error & { status?: number } = new Error('Not Found');
        notFound.status = 404;

        const { service, octokit } = makeService(
            { org: 'personal-owner' },
            { paginate: jest.fn().mockRejectedValue(notFound) },
        );

        const members = await service.getAllMembersByOrg(org);

        expect(members).toEqual([
            { id: 4242, login: 'personal-owner', type: 'User' },
        ]);
        expect(octokit.paginate).toHaveBeenCalled();
        expect(octokit.rest.users.getByUsername).toHaveBeenCalledWith({
            username: 'personal-owner',
        });
    });

    it('does not swallow a non-404 failure from the org listing', async () => {
        const rateLimited: Error & { status?: number } = new Error('rate limit');
        rateLimited.status = 403;

        const { service, octokit } = makeService(
            { org: 'acme', accountType: 'organization' },
            { paginate: jest.fn().mockRejectedValue(rateLimited) },
        );

        await expect(service.getAllMembersByOrg(org)).rejects.toThrow(
            'rate limit',
        );
        expect(octokit.rest.users.getByUsername).not.toHaveBeenCalled();
    });

    it('lists org members unchanged for an organization account', async () => {
        const members = [{ id: 1, login: 'alice', type: 'User' }];
        const { service, octokit } = makeService(
            { org: 'acme', accountType: 'organization' },
            { paginate: jest.fn().mockResolvedValue(members) },
        );

        await expect(service.getAllMembersByOrg(org)).resolves.toEqual(members);
        expect(octokit.paginate).toHaveBeenCalledWith(
            octokit.rest.orgs.listMembers,
            { org: 'acme', per_page: 100 },
        );
    });

    it('returns an empty list when the integration has no auth details', async () => {
        const { service } = makeService(null);

        await expect(service.getAllMembersByOrg(org)).resolves.toEqual([]);
    });
});
