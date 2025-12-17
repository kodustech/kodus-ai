import { STATUS } from '@/config/types/database/status.type';
import { GetAssignedReposUseCase } from '@/core/application/use-cases/permissions/get-assigned-repos.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { subject as caslSubject } from '@casl/ability';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionsAbilityFactory } from './permissionsAbility.factory';
import { extractReposFromAbility } from './policy.handlers';

@Injectable()
export class AuthorizationService {
    constructor(
        private readonly permissionsAbilityFactory: PermissionsAbilityFactory,
        private readonly getAssignedReposUseCase: GetAssignedReposUseCase,
    ) {}

    async check(params: {
        user: Partial<IUser>;
        action: Action;
        resource: ResourceType;
        repoIds?: string[];
        status?: STATUS[];
    }): Promise<boolean> {
        const {
            user,
            action,
            resource,
            repoIds = [undefined],
            status = [STATUS.ACTIVE],
        } = params;

        if (!user || !user.uuid || !user.organization?.uuid) {
            return false;
        }

        if (!status.includes(user.status)) {
            return false;
        }

        const ability = await this.permissionsAbilityFactory.createForUser(
            user as IUser,
        );

        for (const repoId of repoIds) {
            const subject = caslSubject(resource, {
                organizationId: user.organization.uuid,
                ...(repoId ? { repoId } : {}),
            });

            if (!ability.can(action, subject as any)) {
                return false;
            }
        }

        return true;
    }

    async ensure(params: {
        user: Partial<IUser>;
        action: Action;
        resource: ResourceType;
        repoIds?: string[];
        status?: STATUS[];
    }): Promise<void> {
        const { user, action, resource, repoIds, status } = params;

        const isAllowed = await this.check({
            user,
            action,
            resource,
            repoIds,
            status,
        });

        if (!isAllowed) {
            throw new ForbiddenException(
                `User does not have permission to ${action} on ${resource}${repoIds ? ` for repos: ${repoIds.join(', ')}` : ''}`,
            );
        }
    }

    async getRepositoryScope(params: {
        user: Partial<IUser>;
        action: Action;
        resource: ResourceType;
        status?: STATUS[];
    }): Promise<string[] | null> {
        const { user, action, resource, status = [STATUS.ACTIVE] } = params;

        if (!user || !user.organization?.uuid) {
            return [];
        }

        if (!status.includes(user.status)) {
            return [];
        }

        const ability = await this.permissionsAbilityFactory.createForUser(
            user as IUser,
        );

        const orgLevelSubject = caslSubject(resource, {
            organizationId: user.organization.uuid,
        });

        if (ability.can(action, orgLevelSubject as any)) {
            // User has org-wide access.
            return null;
        }

        // If the org-level check fails, the permission MUST be repo-scoped.
        return extractReposFromAbility(ability, action, resource);
    }
}
