import { KodyRulesSyncListener } from '@libs/kodyRules/infrastructure/adapters/listeners/kody-rules-sync.listener';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncListener', () => {
    function buildListener(
        overrides: {
            acquireImpl?: () => Promise<{ release: jest.Mock } | null>;
        } = {},
    ) {
        const kodyRulesSyncService = {
            syncFromChangedFiles: jest.fn().mockResolvedValue(undefined),
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
