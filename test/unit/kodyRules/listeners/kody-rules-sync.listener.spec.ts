import { KodyRulesSyncListener } from '@libs/kodyRules/infrastructure/adapters/listeners/kody-rules-sync.listener';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncListener — handleIdeRulesSyncDisabled', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    function buildListener(
        overrides: {
            acquireImpl?: () => Promise<{ release: jest.Mock } | null>;
        } = {},
    ) {
        const kodyRulesSyncService = {
            syncFromChangedFiles: jest.fn().mockResolvedValue(undefined),
            purgeAllIdeSyncRulesForRepository: jest
                .fn()
                .mockResolvedValue(undefined),
            pauseAllIdeSyncRulesForRepository: jest
                .fn()
                .mockResolvedValue(undefined),
            resumeAllIdeSyncRulesForRepository: jest
                .fn()
                .mockResolvedValue(undefined),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue(null),
        };
        const organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(null),
        };

        // Default: acquire wins with a lock object whose release resolves.
        const releaseMock = jest.fn().mockResolvedValue(undefined);
        const distributedLockService = {
            acquire: jest.fn(
                overrides.acquireImpl ??
                    (() => Promise.resolve({ release: releaseMock })),
            ),
        };

        const listener = new KodyRulesSyncListener(
            kodyRulesSyncService as any,
            parametersService as any,
            organizationParametersService as any,
            distributedLockService as any,
        );

        return {
            listener,
            kodyRulesSyncService,
            distributedLockService,
            releaseMock,
        };
    }

    it('action=delete purges IDE-synced rules', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'delete',
        });

        expect(
            kodyRulesSyncService.purgeAllIdeSyncRulesForRepository,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });
        expect(
            kodyRulesSyncService.pauseAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('action=pause flips IDE-synced rules to PAUSED', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'pause',
        });

        expect(
            kodyRulesSyncService.pauseAllIdeSyncRulesForRepository,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });
        expect(
            kodyRulesSyncService.purgeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('action=keep is a no-op (rules stay ACTIVE)', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
            action: 'keep',
        });

        expect(
            kodyRulesSyncService.purgeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncService.pauseAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncService.resumeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
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

        expect(
            kodyRulesSyncService.purgeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncService.pauseAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('ignores the event when repositoryId is missing', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: undefined as any,
            action: 'delete',
        });

        expect(
            kodyRulesSyncService.purgeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncService.pauseAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    describe('cross-process sync via distributed lock', () => {
        const mergedEvent = {
            merged: true,
            pullRequestNumber: 42,
            repository: { id: 'repo-1', name: 'tiny-url' },
            organizationAndTeamData: { organizationId: 'org-1' },
            files: [{ filename: '.kody/rules/x.md', status: 'added' }],
        } as any;

        it('runs the sync when this process acquires the lock', async () => {
            const { listener, kodyRulesSyncService, releaseMock } =
                buildListener();
            await listener.handlePullRequestClosedEvent(mergedEvent);
            expect(
                kodyRulesSyncService.syncFromChangedFiles,
            ).toHaveBeenCalledTimes(1);
            // finally-block must release even on success
            expect(releaseMock).toHaveBeenCalledTimes(1);
        });

        it('skips the sync when another process holds the lock', async () => {
            const { listener, kodyRulesSyncService } = buildListener({
                acquireImpl: () => Promise.resolve(null),
            });
            await listener.handlePullRequestClosedEvent(mergedEvent);
            expect(
                kodyRulesSyncService.syncFromChangedFiles,
            ).not.toHaveBeenCalled();
        });

        it('releases the lock even if the sync throws', async () => {
            const releaseMock = jest.fn().mockResolvedValue(undefined);
            const { listener, kodyRulesSyncService } = buildListener({
                acquireImpl: () =>
                    Promise.resolve({ release: releaseMock } as any),
            });
            (
                kodyRulesSyncService.syncFromChangedFiles as jest.Mock
            ).mockRejectedValueOnce(new Error('sync boom'));

            await expect(
                listener.handlePullRequestClosedEvent(mergedEvent),
            ).rejects.toThrow('sync boom');
            expect(releaseMock).toHaveBeenCalledTimes(1);
        });
    });
});
