jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const repoGetMock = jest.fn();
jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGet: (...args: unknown[]) => repoGetMock(...args),
}));

import { ForgejoService } from '@libs/platform/infrastructure/adapters/services/forgejo.service';
import { BitbucketDataCenterService } from '@libs/platform/infrastructure/adapters/services/bitbucket/bitbucket-data-center.service';

const params = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    repository: { id: 'repo-1', name: 'acme/shop' },
};

/**
 * The security scan scans the branch a lookup returns: a fallback name
 * ("main", "master") would be scanned as the default. A strict lookup throws
 * instead; everyone else keeps the fallback.
 */
describe('getDefaultBranch, strict', () => {
    describe('Forgejo', () => {
        const self = () => ({
            getAuthDetails: jest.fn(async () => ({ host: 'https://git.acme.dev', token: 't' })),
            extractRepoInfo: () => ({ owner: 'acme', repo: 'shop' }),
            createForgejoClient: () => ({}),
            logger: { error: jest.fn() },
        });
        const call = (extra: object) =>
            (ForgejoService.prototype.getDefaultBranch as any).call(self(), { ...params, ...extra });

        beforeEach(() => repoGetMock.mockReset());

        it('falls back to main on a failed lookup, unless strict', async () => {
            repoGetMock.mockRejectedValue(new Error('502'));

            await expect(call({})).resolves.toBe('main');
            await expect(call({ strict: true })).rejects.toThrow('502');
        });

        it('returns the confirmed branch either way', async () => {
            repoGetMock.mockResolvedValue({ data: { default_branch: 'develop' } });

            await expect(call({ strict: true })).resolves.toBe('develop');
        });
    });

    describe('Bitbucket Data Center', () => {
        const self = (get: jest.Mock) => ({
            getAuthDetails: jest.fn(async () => ({ host: 'https://bb.acme.dev' })),
            getRepoConfig: jest.fn(async () => ({ workspaceId: 'ACME', name: 'shop' })),
            getAxiosInstance: () => ({ get }),
            logger: { error: jest.fn() },
        });
        const call = (get: jest.Mock, extra: object) =>
            (BitbucketDataCenterService.prototype.getDefaultBranch as any).call(self(get), {
                ...params,
                ...extra,
            });

        it('falls back to master on a failed lookup, unless strict', async () => {
            const get = jest.fn(async () => {
                throw new Error('503');
            });

            await expect(call(get, {})).resolves.toBe('master');
            await expect(call(get, { strict: true })).rejects.toThrow('503');
        });

        it('returns the confirmed branch either way', async () => {
            const get = jest.fn(async () => ({ data: { displayId: 'develop' } }));

            await expect(call(get, { strict: true })).resolves.toBe('develop');
        });
    });
});
