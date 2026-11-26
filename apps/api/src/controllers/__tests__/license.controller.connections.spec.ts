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
        workspaceConnectionIds: jest.fn(
            async () => opts.workspaceConnections ?? [],
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

    it('reads and prunes the one granted workspace connection for a member who names none', async () => {
        const { controller, prune, licenseService } = build({
            restricted: ['gh-a', 'gh-elsewhere'],
            workspaceConnections: ['gh-a', 'gl-b'],
            organizationConnections: ['gh-a'],
        });

        await controller.removableSeats('team-1');
        await controller.pruneSeats({ teamId: 'team-1' });

        expect(prune.execute.mock.calls).toEqual([
            [
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                        integrationId: 'gh-a',
                    },
                    dryRun: true,
                },
            ],
            [
                {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                        integrationId: 'gh-a',
                    },
                    gitIds: undefined,
                },
            ],
        ]);

        // Organization-wide, two grants leave the connection unnamed.
        await expect(controller.usersWithLicense()).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(
            licenseService.getAllUsersEverWithLicense,
        ).not.toHaveBeenCalled();
    });

    it('refuses a member granted several workspace connections who names none', async () => {
        const { controller, prune, selfHosted } = build({
            restricted: ['gh-a', 'gl-b'],
            workspaceConnections: ['gh-a', 'gl-b'],
        });

        await expect(
            controller.removableSeats('team-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.assignOrUnassign({
                ...assignBody('gh-a'),
                connectionId: undefined as unknown as string,
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prune.execute).not.toHaveBeenCalled();
        expect(selfHosted.assignLicense).not.toHaveBeenCalled();
    });

    it('lists the seats of the only connection a member is granted', async () => {
        const { controller, licenseService } = build({
            restricted: ['gl-b'],
            organizationConnections: ['gl-b'],
        });

        await controller.usersWithLicense();

        expect(licenseService.getAllUsersEverWithLicense).toHaveBeenCalledWith({
            organizationId: 'org-1',
            integrationId: 'gl-b',
        });
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
