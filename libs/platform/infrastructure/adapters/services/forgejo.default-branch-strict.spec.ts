const repoGet = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGet: (...args: unknown[]) => repoGet(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService.getDefaultBranch — strict', () => {
    const service = Object.create(ForgejoService.prototype) as ForgejoService;

    const lookup = (strict?: boolean) =>
        service.getDefaultBranch({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { name: 'acme/widget-api' },
            strict,
        });

    beforeEach(() => {
        repoGet.mockReset();
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
            configurable: true,
        });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.test',
        });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
    });

    it('asks the client to throw, so a provider failure keeps its status', async () => {
        const failure = Object.assign(new Error('Bad Gateway'), {
            response: { status: 502 },
        });
        repoGet.mockRejectedValue(failure);

        await expect(lookup(true)).rejects.toBe(failure);
        expect(repoGet).toHaveBeenCalledWith(
            expect.objectContaining({ throwOnError: true }),
        );
    });

    it('still falls back to main without strict', async () => {
        repoGet.mockResolvedValue({ data: undefined, error: { message: 'x' } });

        await expect(lookup()).resolves.toBe('main');
        expect(repoGet).toHaveBeenCalledWith(
            expect.objectContaining({ throwOnError: undefined }),
        );
    });
});
