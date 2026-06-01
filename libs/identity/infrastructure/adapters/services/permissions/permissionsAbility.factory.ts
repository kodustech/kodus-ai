import { AbilityBuilder, createMongoAbility, Subject } from '@casl/ability';
import {
    IPermissionsService,
    PERMISSIONS_SERVICE_TOKEN,
} from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { ROLE_POLICIES } from '@libs/identity/domain/permissions/policies/role-policies';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class PermissionsAbilityFactory {
    constructor(
        @Inject(PERMISSIONS_SERVICE_TOKEN)
        private readonly permissionsService: IPermissionsService,
    ) {}

    async createForUser(
        user: IUser,
        repositoryIds?: string[],
    ): Promise<AppAbility> {
        const { can, cannot, build } = new AbilityBuilder(createMongoAbility);

        const userRole = user.role;
        const userOrganizationId = user.organization?.uuid;

        if (!userRole || !userOrganizationId) {
            cannot(Action.Manage, ResourceType.All);

            return build() as AppAbility;
        }

        let assignedRepoUuids: string[] = [];
        if (repositoryIds) {
            assignedRepoUuids = repositoryIds;
        } else {
            const permissionsEntity = await this.permissionsService.findOne({
                user: { uuid: user.uuid },
            });
            assignedRepoUuids =
                permissionsEntity?.permissions?.assignedRepositoryIds || [];
        }

        const canInOrg = <S extends Subject, C>(
            action: Action,
            subject: S,
            conditions?: C,
        ) => {
            const finalConditions = {
                ...conditions,
                organizationId: userOrganizationId,
            };
            can(action, subject, finalConditions);
        };

        const canInRepo = <S extends Subject, C>(
            action: Action,
            subject: S,
            conditions?: C,
            global?: boolean,
        ) => {
            const repos = [...assignedRepoUuids];
            if (global) repos.push('global');

            const finalConditions = {
                ...conditions,
                organizationId: userOrganizationId,
                repoId: {
                    $in: repos,
                },
            };

            can(action, subject, finalConditions);
        };

        // Roles and their grants are defined declaratively in ROLE_POLICIES
        // (framework-free, shared with the frontend) so there is a single
        // source of truth. Here we just translate each rule into a CASL grant.
        const policy = ROLE_POLICIES[userRole];

        if (!policy) {
            cannot(Action.Manage, ResourceType.All);
        } else {
            for (const rule of policy) {
                if (rule.scope === 'repo') {
                    canInRepo(rule.action, rule.resource, {}, rule.global);
                } else {
                    canInOrg(rule.action, rule.resource);
                }
            }
        }

        return build() as AppAbility;
    }
}
