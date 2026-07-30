import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { ResyncRulesFromIdeUseCase } from '@libs/kodyRules/application/use-cases/resync-rules-from-ide.use-case';
import { ValidateRuleFileReferencesUseCase } from '@libs/kodyRules/application/use-cases/validate-rule-file-references.use-case';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('ResyncRulesFromIdeUseCase', () => {
    let useCase: ResyncRulesFromIdeUseCase;
    let kodyRulesSyncServiceMock: { syncRepositoryMain: jest.Mock };
    let codeManagementServiceMock: { getRepositories: jest.Mock };
    let notificationServiceMock: { emit: jest.Mock };
    let validateRuleFileReferencesMock: { execute: jest.Mock };

    beforeEach(async () => {
        kodyRulesSyncServiceMock = {
            syncRepositoryMain: jest.fn().mockResolvedValue(undefined),
        };

        codeManagementServiceMock = {
            getRepositories: jest.fn().mockResolvedValue([
                {
                    id: 'repo-1',
                    name: 'backend-services',
                    fullName: 'quintoandar/backend-services',
                    selected: true,
                    default_branch: 'main',
                },
            ]),
        };

        notificationServiceMock = {
            emit: jest.fn().mockResolvedValue(undefined),
        };

        validateRuleFileReferencesMock = {
            execute: jest
                .fn()
                .mockResolvedValue({ invalidCount: 0, issues: [] }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ResyncRulesFromIdeUseCase,
                {
                    provide: KodyRulesSyncService,
                    useValue: kodyRulesSyncServiceMock,
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementServiceMock,
                },
                {
                    provide: NotificationService,
                    useValue: notificationServiceMock,
                },
                {
                    provide: ValidateRuleFileReferencesUseCase,
                    useValue: validateRuleFileReferencesMock,
                },
                {
                    provide: REQUEST,
                    useValue: {
                        user: {
                            uuid: 'user-1',
                            organization: {
                                uuid: 'org-1',
                            },
                        },
                    },
                },
            ],
        }).compile();

        useCase = module.get(ResyncRulesFromIdeUseCase);
    });

    it('passes an optional path to manual IDE resync', async () => {
        await useCase.execute({
            teamId: 'team-1',
            repositoriesIds: ['repo-1'],
            path: 'qantilever/.cursor/rules/logging.mdc',
        });

        expect(
            kodyRulesSyncServiceMock.syncRepositoryMain,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: expect.objectContaining({
                    id: 'repo-1',
                    name: 'backend-services',
                }),
                path: 'qantilever/.cursor/rules/logging.mdc',
            }),
        );
    });

    describe('notifications', () => {
        it('emits ide.rules_synced per successful repo to the sync_initiator', async () => {
            await useCase.execute({
                teamId: 'team-1',
                repositoriesIds: ['repo-1'],
            });

            expect(notificationServiceMock.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: NotificationEvent.IDE_RULES_SYNCED,
                    organizationId: 'org-1',
                    recipients: { kind: 'user', userId: 'user-1' },
                    payload: expect.objectContaining({
                        repoName: 'backend-services',
                        syncMode: 'full',
                    }),
                }),
            );
        });

        it('emits ide.rules_sync_failed per failing repo + continues to the next one', async () => {
            codeManagementServiceMock.getRepositories.mockResolvedValueOnce([
                {
                    id: 'repo-1',
                    name: 'repo-one',
                    fullName: 'acme/repo-one',
                    selected: true,
                },
                {
                    id: 'repo-2',
                    name: 'repo-two',
                    fullName: 'acme/repo-two',
                    selected: true,
                },
            ]);
            kodyRulesSyncServiceMock.syncRepositoryMain
                .mockRejectedValueOnce(new Error('repo-one boom'))
                .mockResolvedValueOnce(undefined);

            await useCase.execute({
                teamId: 'team-1',
                repositoriesIds: ['repo-1', 'repo-2'],
            });

            // Failed emit for repo-one
            expect(notificationServiceMock.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: NotificationEvent.IDE_RULES_SYNC_FAILED,
                    payload: expect.objectContaining({
                        repoName: 'repo-one',
                        reason: 'repo-one boom',
                    }),
                    // Owners come from the catalog's defaultRoles; only the
                    // sync initiator is a directed recipient.
                    recipients: [{ kind: 'user', userId: 'user-1' }],
                }),
            );

            // Synced emit for repo-two (continued past the failure)
            expect(notificationServiceMock.emit).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: NotificationEvent.IDE_RULES_SYNCED,
                    payload: expect.objectContaining({ repoName: 'repo-two' }),
                }),
            );
        });
    });
});
