import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';

import { FindTeamKeyPullRequestUseCase } from './find-team-key-pull-request.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORG = 'org-1';
const TEAM = 'team-1';

const record = (uuid: string, repository: Record<string, unknown>) => ({
    toObject: () => ({ uuid, number: 42, repository }),
});

const build = (
    lookups: Record<string, Array<ReturnType<typeof record>>>,
    listed: Array<Record<string, unknown>> = [
        { id: 'repo-1', name: 'repo', organizationName: 'acme' },
    ],
) => {
    const pullRequestsService = {
        // Answers by the lookup the filter names.
        find: jest.fn(async (filter: Record<string, unknown>) => {
            const key = filter.url
                ? `url:${filter.url}`
                : filter['repository.id']
                  ? `id:${filter['repository.id']}`
                  : `name:${filter['repository.fullName']}`;
            return lookups[key] ?? [];
        }),
    };
    const integrationConfigService = {
        findIntegrationConfigFormatted: jest.fn().mockResolvedValue(listed),
    };
    return {
        useCase: new FindTeamKeyPullRequestUseCase(
            pullRequestsService as any,
            integrationConfigService as any,
        ),
        pullRequestsService,
        integrationConfigService,
    };
};

const find = (
    useCase: FindTeamKeyPullRequestUseCase,
    over: Record<string, unknown>,
) => useCase.execute({ organizationId: ORG, teamId: TEAM, ...over } as any);

describe('FindTeamKeyPullRequestUseCase', () => {
    it("answers the key workspace's own pull request among records of other servers, reading its repositories once", async () => {
        const { useCase, integrationConfigService } = build({
            'id:repo-1': [
                record('pr-elsewhere', {
                    id: 'repo-1',
                    fullName: 'other/repo',
                }),
                record('pr-own', { id: 'repo-1', fullName: 'acme/repo' }),
            ],
        });

        const found = await find(useCase, {
            repositoryId: 'repo-1',
            prNumber: '42',
        });

        expect(found?.toObject().uuid).toBe('pr-own');
        expect(
            integrationConfigService.findIntegrationConfigFormatted.mock.calls,
        ).toEqual([
            [
                IntegrationConfigKey.REPOSITORIES,
                { organizationId: ORG, teamId: TEAM },
            ],
        ]);
    });

    it('answers an Azure pull request, recorded by the bare repository name', async () => {
        const { useCase } = build(
            {
                'id:azure-guid': [
                    record('pr-azure', { id: 'azure-guid', fullName: 'api' }),
                ],
            },
            [{ id: 'azure-guid', name: 'api', organizationName: 'proj' }],
        );

        const found = await find(useCase, {
            repositoryId: 'azure-guid',
            prNumber: '42',
        });

        expect(found?.toObject().uuid).toBe('pr-azure');
    });

    it('refuses records that match alike on two servers, and one recorded without a name', async () => {
        const twin = { id: 'repo-1', fullName: 'acme/repo' };
        const ambiguous = build({
            'id:repo-1': [record('pr-a', twin), record('pr-b', twin)],
        });
        await expect(
            find(ambiguous.useCase, { repositoryId: 'repo-1', prNumber: '42' }),
        ).resolves.toBeNull();

        const nameless = build({
            'id:repo-1': [record('pr-a', { id: 'repo-1' })],
        });
        await expect(
            find(nameless.useCase, { repositoryId: 'repo-1', prNumber: '42' }),
        ).resolves.toBeNull();
    });

    it('checks every record of a fallback, not one of them', async () => {
        const prUrl = 'https://github.com/acme/repo/pull/42';
        const { useCase, pullRequestsService } = build({
            'name:acme/repo': [
                record('pr-elsewhere', { id: 'repo-9', fullName: 'acme/repo' }),
                record('pr-own', { id: 'repo-1', fullName: 'acme/repo' }),
            ],
        });

        const found = await find(useCase, { prUrl });

        expect(found?.toObject().uuid).toBe('pr-own');
        expect(pullRequestsService.find.mock.calls).toEqual([
            [{ url: prUrl, organizationId: ORG }],
            [
                {
                    'number': 42,
                    'organizationId': ORG,
                    'repository.fullName': 'acme/repo',
                },
            ],
        ]);
    });

    it('answers nothing for a key without a workspace', async () => {
        const { useCase, pullRequestsService } = build({});

        await expect(
            find(useCase, {
                teamId: undefined,
                repositoryId: 'repo-1',
                prNumber: '42',
            }),
        ).resolves.toBeNull();
        expect(pullRequestsService.find).not.toHaveBeenCalled();
    });
});
