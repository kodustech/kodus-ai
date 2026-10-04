import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { GitlabService } from './gitlab.service';

describe('GitlabService — getCheckEvidence', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const repository = { owner: 'acme', name: 'widget-api' };
    const commitSha = 'a1b2c3d4';

    const makeService = (allStatuses: jest.Mock, authDetail: unknown = {}) => {
        const service = Object.create(GitlabService.prototype) as GitlabService;

        // Object.create skips field initializers, so the class logger is absent.
        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue(authDetail);

        jest.spyOn(
            service as unknown as { instanceGitlabApi: () => unknown },
            'instanceGitlabApi',
        ).mockReturnValue({ Commits: { allStatuses } });

        return service;
    };

    const status = (overrides: Record<string, unknown> = {}) => ({
        id: 501,
        name: 'semgrep',
        status: 'success',
        target_url: 'https://example.test/jobs/501',
        finished_at: '2026-01-01T00:00:00Z',
        allow_failure: false,
        ...overrides,
    });

    it('normalizes a successful pipeline job', async () => {
        const service = makeService(jest.fn().mockResolvedValue([status()]));

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([
            {
                id: '501',
                name: 'semgrep',
                status: 'completed',
                conclusion: 'success',
                url: 'https://example.test/jobs/501',
                completedAt: '2026-01-01T00:00:00Z',
                platform: PlatformType.GITLAB,
            },
        ]);
    });

    it('queries the project by owner/name path at the head commit', async () => {
        const allStatuses = jest.fn().mockResolvedValue([]);
        const service = makeService(allStatuses);

        await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(allStatuses).toHaveBeenCalledWith('acme/widget-api', commitSha);
    });

    it.each([
        ['failed', 'failure'],
        ['canceled', 'cancelled'],
        ['skipped', 'skipped'],
    ])('maps a %s job to %s', async (gitlabStatus, expected) => {
        const service = makeService(
            jest.fn().mockResolvedValue([status({ status: gitlabStatus })]),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('completed');
        expect(evidence.conclusion).toBe(expected);
    });

    it.each(['created', 'pending', 'manual', 'scheduled'])(
        'treats a %s job as not yet run',
        async (gitlabStatus) => {
            const service = makeService(
                jest.fn().mockResolvedValue([status({ status: gitlabStatus })]),
            );

            const [evidence] = await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            });

            expect(evidence.status).toBe('queued');
            expect(evidence.conclusion).toBeNull();
        },
    );

    it('treats a running job as in progress', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue([status({ status: 'running' })]),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('in_progress');
    });

    // An allowed-failure job did run and did report — it just does not block
    // the pipeline. Calling it a failure would overstate what CI concluded.
    it('reports an allowed failure as neutral', async () => {
        const service = makeService(
            jest
                .fn()
                .mockResolvedValue([
                    status({ status: 'failed', allow_failure: true }),
                ]),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.conclusion).toBe('neutral');
    });

    it('returns [] when the team has no GitLab auth', async () => {
        const service = makeService(jest.fn(), null);

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });

    it('returns [] when the API call fails', async () => {
        const service = makeService(
            jest.fn().mockRejectedValue(new Error('unavailable')),
        );

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([]);
    });
});
