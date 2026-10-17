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
    handlerName: 'resolve' | 'try' | 'status',
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
        query: handlerName === 'status' ? { repositoryId } : {},
        body: handlerName === 'status' ? {} : { repositoryId },
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

    it('lets an owner try an agent on any repository', async () => {
        expect(await allowed('try', Role.OWNER, OTHER_REPO)).toBe(true);
    });
});

describe('CustomAgentsController team ownership', () => {
    const build = (teamOrganizationId: string | null) => {
        const resolveUseCase = { execute: jest.fn(async () => ({})) };
        const tryUseCase = { execute: jest.fn(async () => ({})) };
        const statusUseCase = { execute: jest.fn(async () => ({})) };
        const teamService = {
            findOneOrganizationIdByTeamId: jest.fn(
                async () => teamOrganizationId,
            ),
        };
        const controller = new CustomAgentsController(
            { user: { organization: { uuid: 'org-1' } } } as any,
            resolveUseCase as any,
            tryUseCase as any,
            statusUseCase as any,
            teamService as any,
        );
        return { controller, resolveUseCase, tryUseCase };
    };

    it('refuses a team of another organization before reading anything', async () => {
        const { controller, resolveUseCase, tryUseCase } = build('org-2');

        await expect(
            controller.resolve({
                teamId: 'team-of-org-2',
                repositoryId: ASSIGNED_REPO,
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            controller.try({
                teamId: 'team-of-org-2',
                repositoryId: ASSIGNED_REPO,
                prUrl: 'https://git.example.test/acme/greenhouse/pull/7',
                agent: { id: 'irrigation' },
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(resolveUseCase.execute).not.toHaveBeenCalled();
        expect(tryUseCase.execute).not.toHaveBeenCalled();
    });

    it('runs for a team of the caller organization', async () => {
        const { controller, resolveUseCase } = build('org-1');

        await controller.resolve({
            teamId: 'team-of-org-1',
            repositoryId: ASSIGNED_REPO,
        });

        expect(resolveUseCase.execute).toHaveBeenCalledTimes(1);
    });
});
