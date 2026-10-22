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
    const refresh = { refreshOneBatch: jest.fn().mockResolvedValue({}) };
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
