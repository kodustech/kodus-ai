import { HttpException, HttpStatus } from '@nestjs/common';

import { GetRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/get-repositories';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

/**
 * A provider failure must reach the repository picker as an error. Answered
 * as an empty list, a rate-limited account looked like it had no
 * repositories at all.
 */
describe('GetRepositoriesUseCase', () => {
    const request = { user: { organization: { uuid: 'org-1' } } } as any;
    const authorizationService = {
        getRepositoryScope: jest.fn().mockResolvedValue(null),
    };

    it('rethrows a provider failure instead of answering an empty list', async () => {
        const rateLimited = new HttpException(
            'Bitbucket is rate limiting this account. Try again in a few minutes.',
            HttpStatus.TOO_MANY_REQUESTS,
        );
        const useCase = new GetRepositoriesUseCase(
            { getRepositories: jest.fn().mockRejectedValue(rateLimited) } as any,
            authorizationService as any,
            request,
        );

        await expect(
            useCase.execute({ teamId: 'team-1', organizationSelected: undefined }),
        ).rejects.toBe(rateLimited);
    });

    it('still lists repositories when the provider answers', async () => {
        const useCase = new GetRepositoriesUseCase(
            {
                getRepositories: jest
                    .fn()
                    .mockResolvedValue([{ id: 'r1', selected: true }]),
            } as any,
            authorizationService as any,
            request,
        );

        await expect(
            useCase.execute({ teamId: 'team-1', organizationSelected: undefined }),
        ).resolves.toEqual([{ id: 'r1', selected: true }]);
    });
});
