import { ForbiddenException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { PERMISSIONS_SERVICE_TOKEN } from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { ManageImportedKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/manage-imported-kody-rules.use-case';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';

/**
 * Repo-scope enforcement for `POST /kody-rules/imported/manage`.
 *
 * The endpoint guard only checks Update on kody_rules at the type level;
 * the `repositoryId` in the body is what decides WHICH repo gets its
 * IDE-synced rules paused/resumed/purged in bulk, so the use case must
 * verify it against the user's assigned repositories. Real
 * AuthorizationService + ability factory (only the permissions repository
 * is mocked) so the tests prove the actual policy outcome.
 */
describe('ManageImportedKodyRulesUseCase — repo scope', () => {
    const counts = { active: 0, paused: 2, deleted: 0, pinned: 0 };

    const syncServiceMock = {
        pauseAllIdeSyncRulesForRepository: jest.fn(),
        resumeAllIdeSyncRulesForRepository: jest.fn(),
        purgeAllIdeSyncRulesForRepository: jest.fn(),
        countIdeSyncRulesForRepository: jest.fn().mockResolvedValue(counts),
    };

    // repo_admin assigned ONLY to repo-a.
    const permissionsServiceMock = {
        findOne: jest.fn(),
    };

    const repoAdminUser = {
        uuid: 'user-1',
        email: 'dev@kodus.io',
        role: Role.REPO_ADMIN,
        status: STATUS.ACTIVE,
        organization: { uuid: 'org-1' },
    };

    const ownerUser = {
        ...repoAdminUser,
        role: Role.OWNER,
    };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const buildUseCase = async (user: Record<string, unknown> | null) => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ManageImportedKodyRulesUseCase,
                AuthorizationService,
                PermissionsAbilityFactory,
                {
                    provide: PERMISSIONS_SERVICE_TOKEN,
                    useValue: permissionsServiceMock,
                },
                {
                    provide: KodyRulesSyncService,
                    useValue: syncServiceMock,
                },
                {
                    provide: REQUEST,
                    useValue: user ? { user } : undefined,
                },
            ],
        }).compile();

        return module.get(ManageImportedKodyRulesUseCase);
    };

    beforeEach(() => {
        jest.clearAllMocks();
        permissionsServiceMock.findOne.mockResolvedValue({
            permissions: { assignedRepositoryIds: ['repo-a'] },
        });
        syncServiceMock.countIdeSyncRulesForRepository.mockResolvedValue(
            counts,
        );
    });

    it('denies a repo admin pausing imported rules of a repository they are not assigned to', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-b',
                action: 'pause',
            }),
        ).rejects.toThrow(ForbiddenException);

        expect(
            syncServiceMock.pauseAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('denies a repo admin bulk-deleting imported rules of a repository they are not assigned to', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        await expect(
            useCase.execute({
                organizationAndTeamData,
                repositoryId: 'repo-b',
                action: 'delete',
            }),
        ).rejects.toThrow(ForbiddenException);

        expect(
            syncServiceMock.purgeAllIdeSyncRulesForRepository,
        ).not.toHaveBeenCalled();
    });

    it('allows a repo admin to pause imported rules of an assigned repository', async () => {
        const useCase = await buildUseCase(repoAdminUser);

        const result = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-a',
            action: 'pause',
        });

        expect(
            syncServiceMock.pauseAllIdeSyncRulesForRepository,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-a',
        });
        expect(result).toEqual({ action: 'pause', counts });
    });

    it('allows the owner to manage imported rules of any repository', async () => {
        const useCase = await buildUseCase(ownerUser);

        const result = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-b',
            action: 'resume',
        });

        expect(
            syncServiceMock.resumeAllIdeSyncRulesForRepository,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-b',
        });
        expect(result).toEqual({ action: 'resume', counts });
    });

    it('keeps machine flows working without a request context', async () => {
        const useCase = await buildUseCase(null);

        const result = await useCase.execute({
            organizationAndTeamData,
            repositoryId: 'repo-b',
            action: 'pause',
        });

        expect(
            syncServiceMock.pauseAllIdeSyncRulesForRepository,
        ).toHaveBeenCalled();
        expect(result).toEqual({ action: 'pause', counts });
    });
});
