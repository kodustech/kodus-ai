import { UnifiedLogHandler } from './unifiedLog.handler';

/**
 * #2581: a bulk settings write logs dozens of records in the same second, and
 * every one of them asked for the same repository name. The lookup is a label
 * on a log line, so a burst should cost one lookup - and one report when it
 * fails - while a repository that appears later still resolves.
 */
describe('UnifiedLogHandler repository name lookups', () => {
    const ORG = 'org-1';
    const REPO = 'repo-9';

    const build = () => {
        const contextResolutionService = {
            getRepositoryNameByOrganizationAndRepository: jest.fn(),
        };
        const handler = new UnifiedLogHandler(
            {} as any,
            contextResolutionService as any,
        );
        const logger = {
            error: jest.fn(),
            warn: jest.fn(),
            log: jest.fn(),
            debug: jest.fn(),
        };
        (handler as any).logger = logger;
        const name = (repositoryId: string, organizationId: string) =>
            (handler as any).getRepositoryAdditionalInfo(
                repositoryId,
                organizationId,
            );
        return { handler, contextResolutionService, logger, name };
    };

    it('looks a repository up once for a burst of records', async () => {
        const { contextResolutionService, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockResolvedValue(
            'acme/api',
        );

        const names = await Promise.all(
            Array.from({ length: 26 }, () => name(REPO, ORG)),
        );

        // 26 records, one lookup, and every record still carries the name.
        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).toHaveBeenCalledTimes(1);
        expect(names).toEqual(Array(26).fill('acme/api'));
    });

    it('reports a failing lookup once, and names the repository unknown', async () => {
        const { contextResolutionService, logger, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockRejectedValue(
            new Error(
                `Repository with id ${REPO} not found in any integration config`,
            ),
        );

        const names = await Promise.all(
            Array.from({ length: 26 }, () => name(REPO, ORG)),
        );

        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationId: ORG,
                repositoryId: REPO,
            }),
        );
        expect(names).toEqual(Array(26).fill('Unknown'));
    });

    it('keeps repositories apart inside one burst', async () => {
        const { contextResolutionService, logger, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockImplementation(
            async (_organizationId: string, repositoryId: string) => {
                if (repositoryId === 'repo-missing') {
                    throw new Error('not found');
                }
                return `acme/${repositoryId}`;
            },
        );

        const names = await Promise.all([
            name('repo-1', ORG),
            name('repo-missing', ORG),
            name('repo-1', ORG),
            name('repo-2', ORG),
        ]);

        expect(names).toEqual([
            'acme/repo-1',
            'Unknown',
            'acme/repo-1',
            'acme/repo-2',
        ]);
        // One lookup per repository, not one per record.
        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).toHaveBeenCalledTimes(3);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('shares a burst, and drops the share before the next one', async () => {
        // Two properties in one measurement, and both matter: a burst is one
        // lookup (the old code did 26), and the entry is gone once it settles
        // (a cache that never forgot would do 1 for the two bursts together).
        const { contextResolutionService, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockResolvedValue(
            'acme/api',
        );

        await Promise.all(Array.from({ length: 26 }, () => name(REPO, ORG)));
        await Promise.all(Array.from({ length: 26 }, () => name(REPO, ORG)));

        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).toHaveBeenCalledTimes(2);
    });

    it('gives up on a lookup that never answers, once, and stops sharing it', async () => {
        // A read that hangs must not hold the audit line, and must not hold
        // every later record of that repository behind the same stuck promise.
        const { contextResolutionService, logger, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockReturnValue(
            new Promise(() => {}),
        );

        jest.useFakeTimers();
        try {
            const burst = Promise.all(
                Array.from({ length: 26 }, () => name(REPO, ORG)),
            );
            await jest.advanceTimersByTimeAsync(5000);

            await expect(burst).resolves.toEqual(Array(26).fill('Unknown'));
            expect(logger.error).toHaveBeenCalledTimes(1);
            expect(
                contextResolutionService.getRepositoryNameByOrganizationAndRepository,
            ).toHaveBeenCalledTimes(1);

            // The entry is gone: the next record tries again instead of
            // awaiting the promise that never settles.
            contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockResolvedValue(
                'acme/api',
            );
            await expect(name(REPO, ORG)).resolves.toBe('acme/api');
            expect(
                contextResolutionService.getRepositoryNameByOrganizationAndRepository,
            ).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not look anything up without a repository or an organization', async () => {
        const { contextResolutionService, name } = build();

        await expect(name('', ORG)).resolves.toBe('');
        await expect(name(REPO, '')).resolves.toBe('');

        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).not.toHaveBeenCalled();
    });

    it('uses the name it was given instead of looking one up', async () => {
        const { handler, contextResolutionService } = build();

        const named = await (handler as any).getRepositoryAdditionalInfo(
            REPO,
            ORG,
            'acme/api',
        );

        expect(named).toBe('acme/api');
        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).not.toHaveBeenCalled();
    });
});
