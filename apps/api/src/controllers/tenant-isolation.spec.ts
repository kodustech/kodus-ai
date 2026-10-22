import { ForbiddenException } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { CodeManagementController } from './codeManagement.controller';
import { OrganizationParametersController } from './organizationParameters.controller';

/**
 * Tenant isolation — these endpoints took the target
 * organizationId from the request (query/body), so any authenticated user
 * could read or write another organization's data. They must scope to the
 * caller's own organization, derived from the authenticated principal.
 *
 * The controllers are instantiated through their prototype to exercise the
 * method's scoping logic without wiring their full dependency graph.
 */
describe('tenant isolation — organizationId comes from the principal', () => {
    const principalOrg = 'my-org';
    const victimOrg = 'victim-org';

    it('search-users ignores a query-supplied organizationId', async () => {
        const controller: any = Object.create(
            CodeManagementController.prototype,
        );
        const execute = jest.fn().mockResolvedValue([]);
        controller.searchCodeManagementUsersUseCase = { execute };
        controller.request = {
            user: { organization: { uuid: principalOrg } },
        };

        await controller.searchUsers({
            organizationId: victimOrg,
            teamId: 't1',
            q: 'x',
        });

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: principalOrg }),
        );
    });

    it('scopes code-area history to the principal organization', async () => {
        const controller: any = Object.create(
            CodeManagementController.prototype,
        );
        controller.request = {
            user: { organization: { uuid: principalOrg } },
        };
        const execute = jest.fn().mockResolvedValue({ map: null });
        controller.getAreaRiskMapUseCase = { execute };

        await controller.getAreaRiskMap({
            repositoryId: 'repo',
            teamId: 'team',
        });
        expect(execute).toHaveBeenCalledWith({
            organizationId: principalOrg,
            repositoryId: 'repo',
            teamId: 'team',
        });
    });

    it('current-user ignores a query-supplied organizationId', async () => {
        const controller: any = Object.create(
            CodeManagementController.prototype,
        );
        const execute = jest.fn().mockResolvedValue({});
        controller.getCurrentCodeManagementUserUseCase = { execute };
        controller.request = {
            user: { organization: { uuid: principalOrg } },
        };

        await controller.getCurrentUser({
            organizationId: victimOrg,
            teamId: 't1',
        });

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({ organizationId: principalOrg }),
        );
    });

    it('auto-license update ignores a body-supplied organizationId', async () => {
        const controller: any = Object.create(
            OrganizationParametersController.prototype,
        );
        const execute = jest.fn().mockResolvedValue(true);
        controller.updateAutoLicenseAllowedUsersUseCase = { execute };
        controller.request = {
            user: { organization: { uuid: principalOrg } },
        };

        await controller.updateAutoLicenseAllowedUsers({
            organizationId: victimOrg,
            teamId: 't1',
            includeCurrentUser: true,
        });

        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: expect.objectContaining({
                    organizationId: principalOrg,
                }),
            }),
        );
    });
});

/**
 * Key denylist — the generic create-or-update endpoint accepted the
 * full key enum, letting any member write privileged keys (spend limit,
 * license). It must refuse those while still allowing ordinary config keys.
 */
describe('organization-parameters create-or-update — key denylist', () => {
    const makeController = () => {
        const controller: any = Object.create(
            OrganizationParametersController.prototype,
        );
        const execute = jest.fn().mockResolvedValue({});
        controller.createOrUpdateOrganizationParametersUseCase = { execute };
        controller.request = { user: { organization: { uuid: 'o1' } } };
        return { controller, execute };
    };

    it('refuses a privileged key (SPEND_LIMIT_CONFIG)', async () => {
        const { controller, execute } = makeController();
        await expect(
            controller.createOrUpdate({
                key: OrganizationParametersKey.SPEND_LIMIT_CONFIG,
                configValue: { monthlyLimit: 0 },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses LICENSE_KEY', async () => {
        const { controller, execute } = makeController();
        await expect(
            controller.createOrUpdate({
                key: OrganizationParametersKey.LICENSE_KEY,
                configValue: 'x',
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('allows an ordinary self-service key (TIMEZONE_CONFIG)', async () => {
        const { controller, execute } = makeController();
        await controller.createOrUpdate({
            key: OrganizationParametersKey.TIMEZONE_CONFIG,
            configValue: { timezone: 'UTC' },
        });
        expect(execute).toHaveBeenCalled();
    });
});
