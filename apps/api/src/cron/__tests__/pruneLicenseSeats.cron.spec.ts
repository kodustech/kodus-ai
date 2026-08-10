import { AutoRevokeRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/auto-revoke-removed-license-seats.use-case';
import { ITeamService } from '@libs/organization/domain/team/contracts/team.service.contract';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { PruneLicenseSeatsCronProvider } from '../pruneLicenseSeats.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

const team = (uuid: string, organizationUuid?: string) => ({
    uuid,
    organization: organizationUuid ? { uuid: organizationUuid } : undefined,
});

const okResult = { status: 'ok', pending: [], revoked: [], failed: [] };

describe('PruneLicenseSeatsCronProvider', () => {
    let cron: PruneLicenseSeatsCronProvider;
    let teamService: jest.Mocked<ITeamService>;
    let autoRevokeUseCase: jest.Mocked<AutoRevokeRemovedLicenseSeatsUseCase>;
    let lockService: jest.Mocked<DistributedLockService>;
    let release: jest.Mock;

    beforeEach(() => {
        release = jest.fn().mockResolvedValue(undefined);

        teamService = {
            findTeamsWithIntegrations: jest.fn().mockResolvedValue([]),
        } as any;

        autoRevokeUseCase = {
            execute: jest.fn().mockResolvedValue(okResult),
        } as any;

        lockService = {
            acquire: jest.fn().mockResolvedValue({ release }),
        } as any;

        cron = new PruneLicenseSeatsCronProvider(
            teamService,
            autoRevokeUseCase,
            lockService,
        );
    });

    it('skips the sweep entirely when another instance holds the lock', async () => {
        lockService.acquire.mockResolvedValue(null);

        await cron.handleCron();

        expect(teamService.findTeamsWithIntegrations).not.toHaveBeenCalled();
    });

    it('skips the sweep when the lock cannot be acquired', async () => {
        lockService.acquire.mockRejectedValue(new Error('redis down'));

        await cron.handleCron();

        expect(teamService.findTeamsWithIntegrations).not.toHaveBeenCalled();
    });

    it('runs the auto revoke for every team with a code management integration', async () => {
        teamService.findTeamsWithIntegrations.mockResolvedValue([
            team('team-1', 'org-1'),
            team('team-2', 'org-2'),
        ] as any);

        await cron.handleCron();

        expect(autoRevokeUseCase.execute).toHaveBeenCalledTimes(2);
        expect(autoRevokeUseCase.execute).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(release).toHaveBeenCalled();
    });

    it('skips a team with no organization', async () => {
        teamService.findTeamsWithIntegrations.mockResolvedValue([
            team('team-orphan'),
        ] as any);

        await cron.handleCron();

        expect(autoRevokeUseCase.execute).not.toHaveBeenCalled();
    });

    it('keeps sweeping the remaining teams when one of them throws', async () => {
        teamService.findTeamsWithIntegrations.mockResolvedValue([
            team('team-1', 'org-1'),
            team('team-2', 'org-2'),
        ] as any);
        autoRevokeUseCase.execute
            .mockRejectedValueOnce(new Error('billing down'))
            .mockResolvedValueOnce(okResult as any);

        await cron.handleCron();

        expect(autoRevokeUseCase.execute).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalled();
    });

    it('releases the lock even when the team lookup fails', async () => {
        teamService.findTeamsWithIntegrations.mockRejectedValue(
            new Error('db down'),
        );

        await expect(cron.handleCron()).rejects.toThrow('db down');
        expect(release).toHaveBeenCalled();
    });
});
