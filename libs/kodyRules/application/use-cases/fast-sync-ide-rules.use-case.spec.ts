import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { FastSyncIdeRulesUseCase } from './fast-sync-ide-rules.use-case';
import { ValidateRuleFileReferencesUseCase } from './validate-rule-file-references.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('FastSyncIdeRulesUseCase — emits', () => {
    let useCase: FastSyncIdeRulesUseCase;
    let syncService: { syncRepositoryMainFast: jest.Mock };
    let codeMgmt: { getRepositories: jest.Mock };
    let notify: { emit: jest.Mock };
    let validateReferences: { execute: jest.Mock };

    const REPO = {
        id: 'repo-1',
        name: 'acme/api',
        fullName: 'acme/api',
        default_branch: 'main',
    };

    const makeCase = async (
        requestUser: { uuid?: string; organization?: { uuid?: string } } | null,
    ) => {
        syncService = {
            syncRepositoryMainFast: jest
                .fn()
                .mockResolvedValue({ rules: [1, 2, 3] }),
        };
        codeMgmt = {
            getRepositories: jest.fn().mockResolvedValue([REPO]),
        };
        notify = { emit: jest.fn().mockResolvedValue(undefined) };
        validateReferences = {
            execute: jest
                .fn()
                .mockResolvedValue({ invalidCount: 0, issues: [] }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                FastSyncIdeRulesUseCase,
                { provide: KodyRulesSyncService, useValue: syncService },
                { provide: CodeManagementService, useValue: codeMgmt },
                { provide: NotificationService, useValue: notify },
                {
                    provide: ValidateRuleFileReferencesUseCase,
                    useValue: validateReferences,
                },
                { provide: REQUEST, useValue: { user: requestUser } },
            ],
        }).compile();

        useCase = module.get(FastSyncIdeRulesUseCase);
    };

    it('emits ide.rules_synced on success with rulesCount from the sync result', async () => {
        await makeCase({
            uuid: 'user-1',
            organization: { uuid: 'org-1' },
        });

        await useCase.execute({ teamId: 'team-1', repositoryId: 'repo-1' });

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.IDE_RULES_SYNCED,
                organizationId: 'org-1',
                recipients: { kind: 'user', userId: 'user-1' },
                payload: {
                    repoName: 'acme/api',
                    rulesCount: 3,
                    syncMode: 'fast',
                },
            }),
        );
    });

    it('emits ide.rules_sync_failed when the sync service throws', async () => {
        await makeCase({
            uuid: 'user-1',
            organization: { uuid: 'org-1' },
        });
        syncService.syncRepositoryMainFast.mockRejectedValueOnce(
            new Error('rate-limited'),
        );

        await expect(
            useCase.execute({ teamId: 'team-1', repositoryId: 'repo-1' }),
        ).rejects.toThrow();

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.IDE_RULES_SYNC_FAILED,
                organizationId: 'org-1',
                // Owners come from the catalog's defaultRoles; only the sync
                // initiator is a directed recipient.
                recipients: [{ kind: 'user', userId: 'user-1' }],
                payload: expect.objectContaining({
                    reason: 'rate-limited',
                    correlationId: expect.any(String),
                }),
            }),
        );
    });

    it('does not emit ide.rules_synced when initiator has no userId', async () => {
        // No request.user.uuid → no sync_initiator recipient.
        await makeCase({ organization: { uuid: 'org-1' } });

        await useCase.execute({ teamId: 'team-1', repositoryId: 'repo-1' });

        const events = notify.emit.mock.calls.map((c) => c[0].event);
        expect(events).not.toContain(NotificationEvent.IDE_RULES_SYNCED);
    });

    it('still emits ide.rules_sync_failed with no directed recipient when initiator userId is missing (owners via audience)', async () => {
        await makeCase({ organization: { uuid: 'org-1' } });
        syncService.syncRepositoryMainFast.mockRejectedValueOnce(
            new Error('fail'),
        );

        await expect(
            useCase.execute({ teamId: 'team-1', repositoryId: 'repo-1' }),
        ).rejects.toThrow();

        expect(notify.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: NotificationEvent.IDE_RULES_SYNC_FAILED,
                recipients: [],
            }),
        );
    });
});
