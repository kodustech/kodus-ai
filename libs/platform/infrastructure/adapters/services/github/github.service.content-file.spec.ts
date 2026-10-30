jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

/**
 * A file that doesn't exist on the ref (a Kody Rule reference to a deleted
 * path, an unset config file) is a normal answer. It was logged as error —
 * 1.4k events/day — and, when head and base are the same branch, fetched a
 * second time from the identical ref before giving up.
 */
describe('GithubService.getRepositoryContentFile — missing file', () => {
    const notFound = () =>
        Object.assign(new Error('Not Found'), { status: 404 });

    const makeService = (getContent: jest.Mock) => {
        const service = new GithubService(
            { findOne: jest.fn() } as any,
            {} as any,
            { createOrUpdateConfig: jest.fn() } as any,
            {
                getFromCache: jest.fn().mockResolvedValue(null),
                addToCache: jest.fn(),
            } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'acme',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            repos: { getContent },
        });
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        (service as any).logger = logger;
        return { service, logger };
    };

    const read = (service: GithubService, head: string, base: string) =>
        service.getRepositoryContentFile({
            organizationAndTeamData: { organizationId: 'org-1' },
            repository: { id: '1', name: 'repo' },
            file: { filename: '.coderabbit.yaml' },
            pullRequest: { head: { ref: head }, base: { ref: base } },
        });

    it('does not log a 404 on both refs as error', async () => {
        const getContent = jest.fn().mockRejectedValue(notFound());
        const { service, logger } = makeService(getContent);

        await expect(read(service, 'feat/x', 'main')).resolves.toBeUndefined();
        expect(getContent).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not refetch the same ref when head and base are the same branch', async () => {
        const getContent = jest.fn().mockRejectedValue(notFound());
        const { service } = makeService(getContent);

        await read(service, 'main', 'main');

        expect(getContent).toHaveBeenCalledTimes(1);
    });

    it('keeps a non-404 failure at error level', async () => {
        const getContent = jest
            .fn()
            .mockRejectedValue(
                Object.assign(new Error('Server Error'), { status: 502 }),
            );
        const { service, logger } = makeService(getContent);

        await read(service, 'feat/x', 'main');

        expect(logger.error).toHaveBeenCalledTimes(1);
    });
});
