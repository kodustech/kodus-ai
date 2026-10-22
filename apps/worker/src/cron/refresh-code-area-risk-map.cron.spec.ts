import { RefreshCodeAreaRiskMapCron } from './refresh-code-area-risk-map.cron';

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

it('skips repositories already known to have unsupported history providers', async () => {
    const teams = {
        findTeamsWithIntegrations: jest
            .fn()
            .mockResolvedValue([
                { uuid: 'team-1', organization: { uuid: 'org-1' } },
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
        readStatus: jest.fn().mockResolvedValue({ source: 'bitbucket' }),
        refreshOneBatch: jest.fn(),
    };
    const release = jest.fn();
    const cron = new RefreshCodeAreaRiskMapCron(
        teams as any,
        parameters as any,
        refresh as any,
        { acquire: jest.fn().mockResolvedValue({ release }) } as any,
        { isEnabled: jest.fn().mockResolvedValue(true) } as any,
    );

    await cron.handleCron();

    expect(refresh.refreshOneBatch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
});
