import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { LicenseController } from '../license.controller';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const build = (opts: {
    restricted?: string[];
    workspaceConnections?: string[];
    organizationConnections?: string[];
}) => {
    const selfHosted = {
        assignLicense: jest.fn().mockResolvedValue(true),
        unassignLicense: jest.fn().mockResolvedValue(true),
    };
    const licenseService = {
        getAllUsersEverWithLicense: jest.fn().mockResolvedValue([]),
    };
    const prune = { execute: jest.fn().mockResolvedValue({ status: 'ok' }) };
    const connectionAccess = {
        restrictionFor: jest.fn(async () =>
            opts.restricted
                ? { connectionIds: new Set(opts.restricted) }
                : null,
        ),
        connectionInWorkspace: jest.fn(async (_o, _t, id: string) =>
            (opts.workspaceConnections ?? []).includes(id),
        ),
        connectionInOrganization: jest.fn(async (_o, id: string) =>
            (opts.organizationConnections ?? []).includes(id),
        ),
    };
    const controller = new LicenseController(
        selfHosted as any,
        licenseService as any,
        {} as any,
        {} as any,
        prune as any,
        { licenseSeatChanged: jest.fn() } as any,
        connectionAccess as any,
        {
            user: { uuid: 'u-1', organization: { uuid: 'org-1' } },
        } as any,
    );
    return { controller, selfHosted, licenseService, prune };
};

const assignBody = (connectionId: string) => ({
    teamId: 'team-1',
    connectionId,
    users: [
        { gitId: '7', gitTool: 'gitlab', licenseStatus: 'active' as const },
    ],
});

describe('LicenseController — the Git connection a seat call names', () => {
    it("assigns on a connection of the caller's workspace", async () => {
        const { controller, selfHosted } = build({
            workspaceConnections: ['gl-b'],
        });

        await controller.assignOrUnassign(assignBody('gl-b'));

        expect(selfHosted.assignLicense).toHaveBeenCalledWith(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                integrationId: 'gl-b',
            },
            '7',
            'gitlab',
        );
    });

    it('refuses a connection outside the workspace, touching no seat', async () => {
        const { controller, selfHosted } = build({
            workspaceConnections: ['gl-b'],
        });

        await expect(
            controller.assignOrUnassign(assignBody('elsewhere')),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(selfHosted.assignLicense).not.toHaveBeenCalled();
    });

    it('refuses a connection the member is not granted, for previews and prunes too', async () => {
        const { controller, prune } = build({
            restricted: ['gh-a'],
            workspaceConnections: ['gh-a', 'gl-b'],
        });

        await expect(
            controller.removableSeats('team-1', 'gl-b'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.pruneSeats({ teamId: 'team-1', connectionId: 'gl-b' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prune.execute).not.toHaveBeenCalled();
    });

    it("lists the seats of a connection of the caller's organization only", async () => {
        const { controller, licenseService } = build({
            organizationConnections: ['gl-b'],
        });

        await controller.usersWithLicense('gl-b');
        await expect(
            controller.usersWithLicense('elsewhere'),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(licenseService.getAllUsersEverWithLicense).toHaveBeenCalledTimes(
            1,
        );
    });

    it('keeps calls that name no connection as they were', async () => {
        const { controller, prune } = build({});

        await controller.removableSeats('team-1');

        expect(prune.execute).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            dryRun: true,
        });
    });
});
