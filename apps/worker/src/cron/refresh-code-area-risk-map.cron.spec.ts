import { RefreshCodeAreaRiskMapCron } from './refresh-code-area-risk-map.cron';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

it('scans only eligible teams and releases the scheduler lock', async () => {
    const teams = {
        findTeamsWithIntegrations: jest.fn().mockResolvedValue([
            { uuid: 'free-team', organization: { uuid: 'free-org' } },
            { uuid: 'paid-team', organization: { uuid: 'paid-org' } },
        ]),
    };
    const parameters = {
        findOne: jest.fn().mockResolvedValue({
            configValue: {
                repositories: [{ id: 'repo-1', name: 'api', isSelected: true }],
            },
        }),
    };
    const refresh = {
        readStatus: jest.fn().mockResolvedValue(null),
        refreshOneBatch: jest.fn().mockResolvedValue({}),
    };
    const codeManagement = {
        getTypeIntegration: jest.fn().mockResolvedValue(PlatformType.GITHUB),
    };
    const release = jest.fn();
    const locks = {
        acquire: jest.fn().mockResolvedValue({ release }),
    };
    const access = {
        isEnabled: jest
            .fn()
            .mockImplementation(
                async ({ organizationId }) => organizationId === 'paid-org',
            ),
    };
    const cron = new RefreshCodeAreaRiskMapCron(
        teams as any,
        parameters as any,
        refresh as any,
        locks as any,
        access as any,
        codeManagement as any,
    );

    await cron.handleCron();

    expect(parameters.findOne).toHaveBeenCalledTimes(1);
    expect(refresh.refreshOneBatch).toHaveBeenCalledTimes(1);
    expect(refresh.refreshOneBatch).toHaveBeenCalledWith({
        organizationAndTeamData: {
            organizationId: 'paid-org',
            teamId: 'paid-team',
        },
        repository: { id: 'repo-1', name: 'api' },
    });
    expect(release).toHaveBeenCalledTimes(1);
});

it('filters unsupported providers before choosing repository pages', async () => {
    const teams = {
        findTeamsWithIntegrations: jest.fn().mockResolvedValue([
            { uuid: 'bitbucket-team', organization: { uuid: 'org-1' } },
            { uuid: 'github-team', organization: { uuid: 'org-1' } },
        ]),
    };
    const parameters = {
        findOne: jest.fn().mockResolvedValue({
            configValue: {
                repositories: [{ id: 'repo-1', name: 'api', isSelected: true }],
            },
        }),
    };
    const refresh = {
        readStatus: jest.fn().mockResolvedValue(null),
        refreshOneBatch: jest.fn().mockResolvedValue({}),
    };
    const codeManagement = {
        getTypeIntegration: jest
            .fn()
            .mockImplementation(async ({ teamId }) =>
                teamId === 'bitbucket-team'
                    ? PlatformType.BITBUCKET
                    : PlatformType.GITHUB,
            ),
    };
    const release = jest.fn();
    const cron = new RefreshCodeAreaRiskMapCron(
        teams as any,
        parameters as any,
        refresh as any,
        { acquire: jest.fn().mockResolvedValue({ release }) } as any,
        { isEnabled: jest.fn().mockResolvedValue(true) } as any,
        codeManagement as any,
    );

    await cron.handleCron();

    expect(parameters.findOne).toHaveBeenCalledTimes(1);
    expect(refresh.refreshOneBatch).toHaveBeenCalledTimes(1);
    expect(refresh.refreshOneBatch).toHaveBeenCalledWith({
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'github-team',
        },
        repository: { id: 'repo-1', name: 'api' },
    });
    expect(release).toHaveBeenCalledTimes(1);
});

// A repository's first scan needs many batches (ten PRs each); one batch per
// visit in a fixed rotation left it incomplete for weeks. Unscanned and
// incomplete repositories go first and keep batching within the run's budget;
// complete ones are refreshed stalest first.
describe('refresh order and batch budget', () => {
    const build = (
        repositories: Array<{ id: string; name: string }>,
        statuses: Record<string, unknown>,
        batches: Record<string, Array<{ complete: boolean; processed: number }>>,
    ) => {
        const refresh = {
            readStatus: jest.fn(
                async (_org: string, repositoryId: string) =>
                    statuses[repositoryId] ?? null,
            ),
            refreshOneBatch: jest.fn(async ({ repository }) => {
                const queue = batches[repository.id] ?? [];
                return queue.shift() ?? { complete: true, processed: 0 };
            }),
        };
        const cron = new RefreshCodeAreaRiskMapCron(
            {
                findTeamsWithIntegrations: jest
                    .fn()
                    .mockResolvedValue([
                        { uuid: 'team-1', organization: { uuid: 'org-1' } },
                    ]),
            } as any,
            {
                findOne: jest.fn().mockResolvedValue({
                    configValue: {
                        repositories: repositories.map((r) => ({
                            ...r,
                            isSelected: true,
                        })),
                    },
                }),
            } as any,
            refresh as any,
            { acquire: jest.fn().mockResolvedValue({ release: jest.fn() }) } as any,
            { isEnabled: jest.fn().mockResolvedValue(true) } as any,
            {
                getTypeIntegration: jest
                    .fn()
                    .mockResolvedValue(PlatformType.GITLAB),
            } as any,
        );
        const order = () =>
            refresh.refreshOneBatch.mock.calls.map(([p]) => p.repository.id);
        return { cron, refresh, order };
    };

    it('scans unscanned, then incomplete, then the stalest complete repository', async () => {
        const { cron, order } = build(
            [
                { id: 'fresh', name: 'fresh' },
                { id: 'stale', name: 'stale' },
                { id: 'partial', name: 'partial' },
                { id: 'never', name: 'never' },
            ],
            {
                fresh: { complete: true, cursorEnd: '2026-10-27T00:00:00Z' },
                stale: { complete: true, cursorEnd: '2026-10-01T00:00:00Z' },
                partial: { complete: false, cursorEnd: '2026-10-20T00:00:00Z' },
            },
            {},
        );

        await cron.handleCron();

        expect(order()).toEqual(['never', 'partial', 'stale', 'fresh']);
    });

    it('keeps batching an incomplete repository until its scan completes', async () => {
        const { cron, order } = build(
            [{ id: 'never', name: 'never' }],
            {},
            {
                never: [
                    { complete: false, processed: 10 },
                    { complete: false, processed: 10 },
                    { complete: true, processed: 4 },
                ],
            },
        );

        await cron.handleCron();

        expect(order()).toEqual(['never', 'never', 'never']);
    });

    it('stops batching a repository that makes no progress', async () => {
        const { cron, order } = build(
            [{ id: 'stuck', name: 'stuck' }],
            {},
            { stuck: [{ complete: false, processed: 0 }] },
        );

        await cron.handleCron();

        expect(order()).toEqual(['stuck']);
    });
});
