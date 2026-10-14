import { CodeManagementController } from './codeManagement.controller';
import { OrganizationParametersController } from './organizationParameters.controller';

/**
 * GHSA-gg8q-h8qq-8pj9 / GHSA-vhp8-28q6-jvrj — these endpoints took the target
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
