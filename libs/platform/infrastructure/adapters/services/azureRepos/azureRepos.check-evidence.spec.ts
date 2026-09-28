import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { AzureReposService } from './azureRepos.service';

describe('AzureReposService — getCheckEvidence', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { owner: 'acme', name: 'widget-api', id: 'repo-uuid' };
    const commitSha = 'a1b2c3d4';

    const makeService = (getPullRequestStatuses: jest.Mock) => {
        const service = Object.create(
            AzureReposService.prototype,
        ) as AzureReposService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        Object.defineProperty(service, 'azureReposRequestHelper', {
            value: { getPullRequestStatuses },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue({ orgName: 'acme', token: 'tok' });

        jest.spyOn(
            service as unknown as {
                getProjectIdFromRepository: () => Promise<string>;
            },
            'getProjectIdFromRepository',
        ).mockResolvedValue('project-1');

        return service;
    };

    const azureStatus = (overrides: Record<string, unknown> = {}) => ({
        id: 7,
        state: 'succeeded',
        context: { name: 'semgrep', genre: 'continuous-integration' },
        targetUrl: 'https://dev.azure.test/build/7',
        updatedDate: '2026-01-01T00:00:00Z',
        ...overrides,
    });

    it('normalizes a succeeded PR status', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue([azureStatus()]),
        );

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                prNumber: 42,
            }),
        ).toEqual([
            {
                id: '7',
                name: 'continuous-integration/semgrep',
                status: 'completed',
                conclusion: 'success',
                url: 'https://dev.azure.test/build/7',
                completedAt: '2026-01-01T00:00:00Z',
                platform: PlatformType.AZURE_REPOS,
            },
        ]);
    });

    // Azure hangs statuses off the pull request, so without a PR number there
    // is nothing to query — a commit SHA alone cannot address them.
    it('returns [] when no PR number is supplied', async () => {
        const getPullRequestStatuses = jest.fn();
        const service = makeService(getPullRequestStatuses);

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
        expect(getPullRequestStatuses).not.toHaveBeenCalled();
    });

    it('queries the pull request by id', async () => {
        const getPullRequestStatuses = jest.fn().mockResolvedValue([]);
        const service = makeService(getPullRequestStatuses);

        await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
            prNumber: 42,
        });

        expect(getPullRequestStatuses).toHaveBeenCalledWith(
            expect.objectContaining({
                projectId: 'project-1',
                repositoryId: 'repo-uuid',
                prId: 42,
            }),
        );
    });

    it.each([
        ['failed', 'failure'],
        ['error', 'failure'],
        ['notApplicable', 'skipped'],
    ])('maps a %s state to %s', async (state, expected) => {
        const service = makeService(
            jest.fn().mockResolvedValue([azureStatus({ state })]),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
            prNumber: 42,
        });

        expect(evidence.conclusion).toBe(expected);
    });

    it.each(['pending', 'notSet'])(
        'treats a %s state as unfinished',
        async (state) => {
            const service = makeService(
                jest.fn().mockResolvedValue([azureStatus({ state })]),
            );

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                prNumber: 42,
            });

            expect(evidence.status).toBe('in_progress');
            expect(evidence.conclusion).toBeNull();
        },
    );

    // The genre qualifies the name and is what distinguishes two checks that
    // happen to share a context name across different pipelines.
    it('qualifies the name with the status genre when present', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue([
                azureStatus({
                    context: { name: 'scan', genre: 'security' },
                }),
            ]),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
            prNumber: 42,
        });

        expect(evidence.name).toBe('security/scan');
    });

    it('returns [] when the API call fails', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(new Error('unauthorized')),
        );

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
                prNumber: 42,
            }),
        ).toEqual([]);
    });
});
