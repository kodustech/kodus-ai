import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { BitbucketCloudService } from './bitbucket-cloud.service';

describe('BitbucketCloudService — getCheckEvidence', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { owner: 'acme', name: 'widget-api' };
    const commitSha = 'a1b2c3d4';

    const makeService = (listCommitStatuses: jest.Mock, authDetail: unknown = {}) => {
        const service = Object.create(
            BitbucketCloudService.prototype,
        ) as BitbucketCloudService;

        Object.defineProperty(service, 'logger', {
            value: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });

        jest.spyOn(
            service as unknown as { getAuthDetails: () => Promise<unknown> },
            'getAuthDetails',
        ).mockResolvedValue(authDetail);

        jest.spyOn(
            service as unknown as { instanceBitbucketApi: () => unknown },
            'instanceBitbucketApi',
        ).mockReturnValue({ repositories: { listCommitStatuses } });

        return service;
    };

    const status = (overrides: Record<string, unknown> = {}) => ({
        key: 'SEMGREP',
        name: 'semgrep',
        state: 'SUCCESSFUL',
        url: 'https://bitbucket.test/builds/1',
        updated_on: '2026-01-01T00:00:00Z',
        ...overrides,
    });

    it('normalizes a successful build status', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue({ data: { values: [status()] } }),
        );

        expect(
            await service.getCheckEvidence({
                organizationAndTeamData,
                repository,
                commitSha,
            }),
        ).toEqual([
            {
                id: 'SEMGREP',
                name: 'semgrep',
                status: 'completed',
                conclusion: 'success',
                url: 'https://bitbucket.test/builds/1',
                completedAt: '2026-01-01T00:00:00Z',
                platform: PlatformType.BITBUCKET,
            },
        ]);
    });

    it('queries the head commit', async () => {
        const listCommitStatuses = jest
            .fn()
            .mockResolvedValue({ data: { values: [] } });
        const service = makeService(listCommitStatuses);

        await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(listCommitStatuses).toHaveBeenCalledWith(
            expect.objectContaining({
                workspace: 'acme',
                repo_slug: 'widget-api',
                commit: commitSha,
            }),
        );
    });

    it.each([
        ['FAILED', 'failure'],
        ['STOPPED', 'cancelled'],
    ])('maps a %s state to %s', async (state, expected) => {
        const service = makeService(
            jest.fn().mockResolvedValue({ data: { values: [status({ state })] } }),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.conclusion).toBe(expected);
    });

    it('treats an in-progress build as unfinished', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue({
                data: { values: [status({ state: 'INPROGRESS' })] },
            }),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.status).toBe('in_progress');
        expect(evidence.conclusion).toBeNull();
    });

    // Name is optional on Bitbucket statuses; the key is what is always set,
    // and it is what the analyzer recognizer has to fall back to.
    it('falls back to the status key when no name is set', async () => {
        const service = makeService(
            jest.fn().mockResolvedValue({
                data: { values: [status({ name: undefined })] },
            }),
        );

        const [evidence] = await service.getCheckEvidence({
            organizationAndTeamData,
            repository,
            commitSha,
        });

        expect(evidence.name).toBe('SEMGREP');
    });

    it('returns [] when the team has no Bitbucket auth', async () => {
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
            jest.fn().mockRejectedValue(new Error('forbidden')),
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
