const repoGetRepoPermissions = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGetRepoPermissions: (...args: unknown[]) =>
        repoGetRepoPermissions(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — userCanWrite', () => {
    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: '9', name: 'acme/ledger' },
        login: 'dev',
    };

    beforeEach(() => repoGetRepoPermissions.mockReset());

    const makeService = () => {
        const service = Object.create(
            ForgejoService.prototype,
        ) as ForgejoService;
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({ host: 'https://git.test' });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
        return service;
    };

    it.each([
        ['owner', true],
        ['admin', true],
        ['write', true],
        ['read', false],
        ['none', false],
    ])('a %s permission can write: %s', async (permission, expected) => {
        repoGetRepoPermissions.mockResolvedValue({
            data: { permission },
            response: { status: 200 },
        });

        expect(await makeService().userCanWrite(params)).toBe(expected);
        expect(repoGetRepoPermissions).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { owner: 'acme', repo: 'ledger', collaborator: 'dev' },
            }),
        );
    });

    it('cannot say when Forgejo refuses the read', async () => {
        repoGetRepoPermissions.mockResolvedValue({
            error: { message: 'forbidden' },
            response: { status: 403, headers: {} },
        });

        expect(await makeService().userCanWrite(params)).toBeUndefined();
    });

    it('cannot say without a login', async () => {
        expect(
            await makeService().userCanWrite({ ...params, login: undefined }),
        ).toBeUndefined();
        expect(repoGetRepoPermissions).not.toHaveBeenCalled();
    });
});
