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

    it('looks the name up again once the burst is over', async () => {
        // No permanent cache: a repository that is added to the integration
        // config after a failed burst has to resolve on the next record.
        const { contextResolutionService, name } = build();
        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockRejectedValueOnce(
            new Error('not found'),
        );
        await name(REPO, ORG);

        contextResolutionService.getRepositoryNameByOrganizationAndRepository.mockResolvedValueOnce(
            'acme/api',
        );
        await expect(name(REPO, ORG)).resolves.toBe('acme/api');

        expect(
            contextResolutionService.getRepositoryNameByOrganizationAndRepository,
        ).toHaveBeenCalledTimes(2);
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
