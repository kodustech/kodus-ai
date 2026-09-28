const repoListStatusesByRef = jest.fn();

jest.mock('@llamaduck/forgejo-ts', () => ({
    ...jest.requireActual('@llamaduck/forgejo-ts'),
    repoListStatusesByRef: (...args: unknown[]) =>
        repoListStatusesByRef(...args),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ForgejoService } from './forgejo.service';

describe('ForgejoService — getCheckEvidence', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { owner: 'acme', name: 'widget-api' };
    const commitSha = 'a1b2c3d4';

    beforeEach(() => repoListStatusesByRef.mockReset());

    const makeService = (
        authDetail: unknown = { host: 'https://git.test' },
    ) => {
        const service = Object.create(
            ForgejoService.prototype,
        ) as ForgejoService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue(authDetail);

        jest.spyOn(service, 'createForgejoClient').mockReturnValue({} as never);

        return service;
    };

    const status = (overrides: Record<string, unknown> = {}) => ({
        id: 12,
        context: 'gitleaks',
        status: 'success',
        target_url: 'https://git.test/runs/12',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    });

    it('normalizes a successful commit status', async () => {
        repoListStatusesByRef.mockResolvedValue({ data: [status()] });
        const service = makeService();

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([
            {
                id: '12',
                name: 'gitleaks',
                status: 'completed',
                conclusion: 'success',
                url: 'https://git.test/runs/12',
                completedAt: '2026-01-01T00:00:00Z',
                platform: PlatformType.FORGEJO,
            },
        ]);
    });

    it('queries the head commit ref', async () => {
        repoListStatusesByRef.mockResolvedValue({ data: [] });
        const service = makeService();

        await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(repoListStatusesByRef).toHaveBeenCalledWith(
            expect.objectContaining({
                path: { owner: 'acme', repo: 'widget-api', ref: commitSha },
            }),
        );
    });

    it.each([
        ['failure', 'failure'],
        ['error', 'failure'],
        ['warning', 'neutral'],
    ])('maps a %s status to %s', async (forgejoStatus, expected) => {
        repoListStatusesByRef.mockResolvedValue({
            data: [status({ status: forgejoStatus })],
        });
        const service = makeService();

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('completed');
        expect(evidence.conclusion).toBe(expected);
    });

    it('treats a pending status as unfinished', async () => {
        repoListStatusesByRef.mockResolvedValue({
            data: [status({ status: 'pending' })],
        });
        const service = makeService();

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('in_progress');
        expect(evidence.conclusion).toBeNull();
        expect(evidence.completedAt).toBeNull();
    });

    it('returns [] when the team has no Forgejo auth', async () => {
        const service = makeService(null);

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });

    it('returns [] when the API call fails', async () => {
        repoListStatusesByRef.mockRejectedValue(new Error('unreachable'));
        const service = makeService();

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });
});
