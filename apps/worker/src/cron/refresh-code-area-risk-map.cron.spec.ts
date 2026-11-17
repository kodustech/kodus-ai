import { RefreshCodeAreaRiskMapCron } from './refresh-code-area-risk-map.cron';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CodeAreaHistoryUnavailableError } from '@libs/platformData/domain/code-area-risk/code-area-risk-map.contract';

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
        refreshOneBatch: jest
            .fn()
            .mockResolvedValue({ complete: true, processed: 0, failed: false }),
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
        refreshOneBatch: jest
            .fn()
            .mockResolvedValue({ complete: true, processed: 0, failed: false }),
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
// visit in a fixed rotation left it incomplete for weeks. Incomplete and
// unscanned repositories go first and keep batching within the run's budget;
// complete ones are refreshed stalest first.
describe('refresh order and batch budget', () => {
    const build = (
        repositories: Array<{
            id: string;
            name: string;
            configs?: Record<string, boolean>;
            directories?: Array<{ configs: Record<string, boolean> }>;
        }>,
        statuses: Record<string, unknown>,
        batches: Record<
            string,
            Array<{ complete: boolean; processed: number; failed: boolean }>
        >,
        configs: Record<string, boolean> = {},
    ) => {
        const refresh = {
            readStatus: jest.fn(async (_org: string, repositoryId: string) => {
                const status = statuses[repositoryId];
                if (status instanceof Error) throw status;
                return status ?? null;
            }),
            refreshOneBatch: jest.fn(async ({ repository }) => {
                const queue = batches[repository.id] ?? [];
                return (
                    queue.shift() ?? {
                        complete: true,
                        processed: 0,
                        failed: false,
                    }
                );
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
                        configs,
                        repositories: repositories.map((r) => ({
                            ...r,
                            isSelected: true,
                        })),
                    },
                }),
            } as any,
            refresh as any,
            {
                acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
            } as any,
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

    it('prioritizes effective risk approval across saved global, repository and directory scopes', async () => {
        const { cron, order } = build(
            [
                {
                    id: 'a-parent-off',
                    name: 'a',
                    configs: { pullRequestApprovalActive: false },
                },
                {
                    id: 'b-risk-off',
                    name: 'b',
                    configs: { approvalRiskActive: false },
                },
                {
                    id: 'c-directory',
                    name: 'c',
                    configs: { approvalRiskActive: false },
                    directories: [{ configs: { approvalRiskActive: true } }],
                },
                { id: 'd-inherited', name: 'd' },
                {
                    id: 'e-repository',
                    name: 'e',
                    configs: { approvalRiskActive: true },
                },
            ],
            {
                'a-parent-off': { complete: false },
                'd-inherited': { complete: true },
            },
            {},
            { pullRequestApprovalActive: true, approvalRiskActive: true },
        );
        await cron.handleCron();
        expect(order()).toEqual([
            'c-directory',
            'e-repository',
            'd-inherited',
            'a-parent-off',
            'b-risk-off',
        ]);
    });

    it('prioritizes independent risk with approval off and honors an explicit risk-off override', async () => {
        const { cron, order } = build(
            [
                {
                    id: 'a-off',
                    name: 'off',
                    configs: {
                        riskAssessmentActive: false,
                        pullRequestApprovalActive: true,
                        approvalRiskActive: true,
                    },
                },
                {
                    id: 'b-shared',
                    name: 'shared',
                    configs: {
                        riskAssessmentActive: true,
                        pullRequestApprovalActive: false,
                    },
                },
            ],
            {},
            {},
            {},
        );
        await cron.handleCron();
        expect(order()).toEqual(['b-shared', 'a-off']);
    });

    it('keeps the 40-batch cap when risk approval takes priority over an unfinished scan', async () => {
        const { cron, order } = build(
            [
                { id: 'ordinary', name: 'ordinary' },
                {
                    id: 'risk',
                    name: 'risk',
                    configs: {
                        pullRequestApprovalActive: true,
                        approvalRiskActive: true,
                    },
                },
            ],
            { ordinary: { complete: false } },
            {
                risk: Array.from({ length: 41 }, () => ({
                    complete: false,
                    processed: 10,
                    failed: false,
                })),
            },
        );
        await cron.handleCron();
        expect(order()).toEqual(Array(40).fill('risk'));
    });

    it('scans incomplete, then unscanned, then the stalest complete repository', async () => {
        const { cron, order } = build(
            [
                { id: 'fresh', name: 'fresh' },
                { id: 'stale', name: 'stale' },
                { id: 'partial', name: 'partial' },
                { id: 'never', name: 'never' },
            ],
            {
                // A complete scan's cursor sits at its floor; staleness is
                // when its window ended.
                fresh: {
                    complete: true,
                    windowEnd: '2026-10-27T00:00:00Z',
                    cursorEnd: '2026-09-01T00:00:00Z',
                },
                stale: {
                    complete: true,
                    windowEnd: '2026-10-01T00:00:00Z',
                    cursorEnd: '2026-10-26T00:00:00Z',
                },
                partial: { complete: false, cursorEnd: '2026-10-20T00:00:00Z' },
            },
            {},
        );

        await cron.handleCron();

        // A scan the last run's budget cut short goes on before any new one.
        expect(order()).toEqual(['partial', 'never', 'stale', 'fresh']);
    });

    it('keeps batching an incomplete repository until its scan completes', async () => {
        const { cron, order } = build(
            [{ id: 'never', name: 'never' }],
            {},
            {
                never: [
                    { complete: false, processed: 10, failed: false },
                    { complete: false, processed: 10, failed: false },
                    { complete: true, processed: 4, failed: false },
                ],
            },
        );

        await cron.handleCron();

        expect(order()).toEqual(['never', 'never', 'never']);
    });

    it('keeps batching through empty weeks and unmerged PRs', async () => {
        const { cron, order } = build(
            [{ id: 'quiet', name: 'quiet' }],
            {},
            {
                quiet: [
                    { complete: false, processed: 0, failed: false },
                    { complete: false, processed: 0, failed: false },
                ],
            },
        );

        await cron.handleCron();

        expect(order()).toEqual(['quiet', 'quiet', 'quiet']);
    });

    it('starts no batch once the run passes its deadline, well inside the lock', async () => {
        let now = 0;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const { cron, refresh, order } = build(
                [
                    { id: 'slow', name: 'slow' },
                    { id: 'next', name: 'next' },
                ],
                {
                    slow: {
                        complete: false,
                        cursorEnd: '2026-10-20T00:00:00Z',
                    },
                },
                {},
            );
            // Each batch takes 40 minutes and never completes the scan.
            refresh.refreshOneBatch.mockImplementation(async () => {
                now += 40 * 60 * 1000;
                return { complete: false, processed: 10, failed: false };
            });

            await cron.handleCron();

            // Batches start at 0, 40 and 80 minutes; none at 120, when the
            // two-hour lock would let the next run in.
            expect(order()).toEqual(['slow', 'slow', 'slow']);
        } finally {
            clock.mockRestore();
        }
    });

    it('stops batching a repository whose PRs could not be read', async () => {
        const { cron, order } = build(
            [{ id: 'stuck', name: 'stuck' }],
            {},
            { stuck: [{ complete: false, processed: 0, failed: true }] },
        );

        await cron.handleCron();

        expect(order()).toEqual(['stuck']);
    });

    it('puts a repository whose status could not be read last', async () => {
        const { cron, order } = build(
            [
                { id: 'broken', name: 'broken' },
                { id: 'done', name: 'done' },
            ],
            {
                broken: new Error('mongo unavailable'),
                done: { complete: true, windowEnd: '2026-10-27T00:00:00Z' },
            },
            {},
        );

        await cron.handleCron();

        expect(order()).toEqual(['done', 'broken']);
    });

    it('puts a repository whose status read never settles last', async () => {
        jest.useFakeTimers();
        try {
            const { cron, refresh, order } = build(
                [
                    { id: 'hung', name: 'hung' },
                    { id: 'done', name: 'done' },
                ],
                { done: { complete: true, windowEnd: '2026-10-27T00:00:00Z' } },
                {},
            );
            refresh.readStatus.mockImplementation(
                async (_org: string, repositoryId: string) =>
                    repositoryId === 'hung'
                        ? new Promise(() => {})
                        : { complete: true, windowEnd: '2026-10-27T00:00:00Z' },
            );

            const run = cron.handleCron();
            await jest.advanceTimersByTimeAsync(10_000);
            await run;

            expect(order()).toEqual(['done', 'hung']);
        } finally {
            jest.useRealTimers();
        }
    });

    it('skips a repository until its listing backoff runs out', async () => {
        const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const earlier = new Date(Date.now() - 60 * 1000).toISOString();
        const { cron, order } = build(
            [
                { id: 'waiting', name: 'waiting' },
                { id: 'due', name: 'due' },
            ],
            {
                waiting: { complete: false, retryAfter: later },
                due: { complete: false, retryAfter: earlier },
            },
            {},
        );

        await cron.handleCron();

        expect(order()).toEqual(['due']);
    });

    it('reports an unreadable repository when it starts failing, not on each retry', async () => {
        const { cron, refresh } = build(
            [
                { id: 'new-failure', name: 'a' },
                { id: 'still-failing', name: 'b' },
            ],
            {},
            {},
        );
        refresh.refreshOneBatch.mockImplementation(async ({ repository }) => {
            throw new CodeAreaHistoryUnavailableError(
                repository.id === 'new-failure' ? 1 : 3,
                new Date().toISOString(),
            );
        });
        const warn = jest.spyOn((cron as any).logger, 'warn');

        await cron.handleCron();

        expect(refresh.refreshOneBatch).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatchObject({
            metadata: { repositoryId: 'new-failure' },
        });
    });
});
