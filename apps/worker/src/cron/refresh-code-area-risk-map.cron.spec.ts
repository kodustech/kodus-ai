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
