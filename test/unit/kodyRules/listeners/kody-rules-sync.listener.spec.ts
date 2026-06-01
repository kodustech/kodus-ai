import { KodyRulesSyncListener } from '@libs/kodyRules/infrastructure/adapters/listeners/kody-rules-sync.listener';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncListener — handleIdeRulesSyncDisabled', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

    function buildListener() {
        const kodyRulesSyncService = {
            syncFromChangedFiles: jest.fn().mockResolvedValue(undefined),
            purgeAllIdeSyncRulesForRepository: jest.fn().mockResolvedValue(undefined),
            pauseAllIdeSyncRulesForRepository: jest.fn().mockResolvedValue(undefined),
            resumeAllIdeSyncRulesForRepository: jest.fn().mockResolvedValue(undefined),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue(null),
        };

        const listener = new KodyRulesSyncListener(
            kodyRulesSyncService as any,
            parametersService as any,
        );

        return { listener, kodyRulesSyncService };
    }

    it('action=delete purges IDE-synced rules', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'delete',
        });

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });
        expect(kodyRulesSyncService.pauseAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });

    it('action=pause flips IDE-synced rules to PAUSED', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'pause',
        });

        expect(kodyRulesSyncService.pauseAllIdeSyncRulesForRepository).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });
        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });

    it('action=keep is a no-op (rules stay ACTIVE)', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'keep',
        });

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
        expect(kodyRulesSyncService.pauseAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
        expect(kodyRulesSyncService.resumeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });

    it('missing action defaults to keep (least destructive)', async () => {
        // REGRESSION GUARD: previously the listener always purged on this event,
        // which silently deleted rules when the user toggled IDE auto-sync off.
        // Defaulting to 'keep' ensures any caller that doesn't pass an explicit
        // action gets the safe behaviour.
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        } as any);

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
        expect(kodyRulesSyncService.pauseAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });

    it('ignores the event when repositoryId is missing', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: undefined as any,
            action: 'delete',
        });

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
        expect(kodyRulesSyncService.pauseAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });
});
