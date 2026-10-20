import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';

import { CustomAgentsController } from '../customAgents.controller';

/**
 * The custom agent endpoints read a repository's skills, docs and pull
 * requests, and Try it runs an agent on one of its pull requests. Reading
 * settings is organization wide, but a try is scoped to the repository like
 * a settings edit, and a team id from the request must belong to the
 * caller's organization.
 */
const ASSIGNED_REPO = 'repo-assigned';
const OTHER_REPO = 'repo-other';

async function abilityFor(role: Role) {
    const factory = new PermissionsAbilityFactory({
        findOne: async () => ({
            permissions: { assignedRepositoryIds: [ASSIGNED_REPO] },
        }),
    } as any);
    return factory.createForUser(
        {
            uuid: `u-${role}`,
            role,
            organization: { uuid: 'org-1' },
        } as unknown as IUser,
        [ASSIGNED_REPO],
    );
}

async function allowed(
    handlerName: 'resolve' | 'try' | 'tryRun' | 'status',
    role: Role,
    repositoryId: string,
): Promise<boolean> {
    const handlers = Reflect.getMetadata(
        'check_policy',
        CustomAgentsController.prototype[handlerName],
    ) as Array<(ability: unknown, request: unknown) => boolean>;
    const ability = await abilityFor(role);
    const request = {
        user: {
            uuid: `u-${role}`,
            role,
            status: STATUS.ACTIVE,
            organization: { uuid: 'org-1' },
        },
        params: {},
        query:
            handlerName === 'status' || handlerName === 'tryRun'
                ? { repositoryId }
                : {},
        body:
            handlerName === 'status' || handlerName === 'tryRun'
                ? {}
                : { repositoryId },
    };
    return handlers.every((handler) => handler(ability, request));
}

describe('CustomAgentsController repository scope', () => {
    it('lets a repository admin try an agent on the repository assigned to them', async () => {
        expect(await allowed('try', Role.REPO_ADMIN, ASSIGNED_REPO)).toBe(true);
    });

    it('keeps a repository admin from trying an agent on another repository', async () => {
        expect(await allowed('try', Role.REPO_ADMIN, OTHER_REPO)).toBe(false);
    });

    it("scopes reading a try's result like starting it", async () => {
        expect(await allowed('tryRun', Role.REPO_ADMIN, ASSIGNED_REPO)).toBe(
            true,
        );
        expect(await allowed('tryRun', Role.REPO_ADMIN, OTHER_REPO)).toBe(
            false,
        );
        expect(await allowed('tryRun', Role.CONTRIBUTOR, ASSIGNED_REPO)).toBe(
            false,
        );
    });

    it('lets an owner try an agent on any repository', async () => {
        expect(await allowed('try', Role.OWNER, OTHER_REPO)).toBe(true);
    });
});

describe('CustomAgentsController team ownership', () => {
    /** Runs the controller's class guards the way Nest would, with a team
     *  service that places the team in `teamOrganizationId`. */
    const runClassGuards = async (
        teamOrganizationId: string | null,
        request: Record<string, unknown>,
    ) => {
        const guards = (Reflect.getMetadata(
            '__guards__',
            CustomAgentsController,
        ) ?? []) as Array<new (...args: any[]) => any>;
        const teamService = {
            findOneOrganizationIdByTeamId: jest.fn(
                async () => teamOrganizationId,
            ),
        };
        const context = {
            switchToHttp: () => ({
                getRequest: () => ({
                    user: { organization: { uuid: 'org-1' } },
                    params: {},
                    query: {},
                    body: {},
                    ...request,
                }),
            }),
        };
        for (const Guard of guards) {
            await new Guard(teamService).canActivate(context);
        }
        return guards;
    };

    it('refuses a team of another organization before any handler runs', async () => {
        await expect(
            runClassGuards('org-2', {
                body: { teamId: 'team-of-org-2', repositoryId: ASSIGNED_REPO },
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            runClassGuards('org-2', {
                query: { teamId: 'team-of-org-2', repositoryId: ASSIGNED_REPO },
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a team of the caller organization through', async () => {
        const guards = await runClassGuards('org-1', {
            body: { teamId: 'team-of-org-1', repositoryId: ASSIGNED_REPO },
        });
        expect(guards.length).toBeGreaterThan(0);
    });
});
