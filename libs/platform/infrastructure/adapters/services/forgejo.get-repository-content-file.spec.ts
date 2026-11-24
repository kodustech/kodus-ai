const repoGetContents = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoGetContents: (...args: unknown[]) => repoGetContents(...args),
}));

import { ForgejoService } from './forgejo.service';

describe('ForgejoService.getRepositoryContentFile — response shape', () => {
    const service = Object.create(ForgejoService.prototype) as ForgejoService;

    const read = (filename = '.cursor/rules/style.mdc') =>
        service.getRepositoryContentFile({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { name: 'acme/widget-api' },
            file: { filename },
            pullRequest: { head: { ref: 'feat/x' }, base: { ref: 'main' } },
        });

    beforeEach(() => {
        repoGetContents.mockReset();
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
            configurable: true,
        });
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
            host: 'https://git.test',
        });
        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);
    });

    it('exposes the decoded content and encoding under data', async () => {
        repoGetContents.mockResolvedValue({
            data: {
                name: 'style.mdc',
                path: '.cursor/rules/style.mdc',
                sha: 'abc',
                size: 5,
                type: 'file',
                encoding: 'base64',
                content: Buffer.from('hello', 'utf-8').toString('base64'),
            },
        });

        const result = await read();

        expect(result?.data?.content).toBe('hello');
        expect(result?.data?.encoding).toBe('utf-8');
        expect(result?.data).toMatchObject({
            name: 'style.mdc',
            path: '.cursor/rules/style.mdc',
            sha: 'abc',
        });
        expect(repoGetContents).toHaveBeenCalledWith(
            expect.objectContaining({
                path: {
                    owner: 'acme',
                    repo: 'widget-api',
                    filepath: '.cursor/rules/style.mdc',
                },
                query: { ref: 'feat/x' },
            }),
        );
    });

    it('returns null for a directory', async () => {
        repoGetContents.mockResolvedValue({ data: [{ name: 'a' }] });

        expect(await read()).toBeNull();
    });

    it('returns null without logging an error for a missing file', async () => {
        repoGetContents.mockRejectedValue(
            Object.assign(new Error('Not Found'), { status: 404 }),
        );

        expect(await read('kodus-config.yml')).toBeNull();
        expect((service as any).logger.error).not.toHaveBeenCalled();
    });

    it('keeps other failures at error level and returns null', async () => {
        repoGetContents.mockRejectedValue(
            Object.assign(new Error('Server Error'), { status: 500 }),
        );

        expect(await read()).toBeNull();
        expect((service as any).logger.error).toHaveBeenCalledTimes(1);
    });
});
