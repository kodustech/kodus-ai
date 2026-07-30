import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';

@Injectable()
export class GetPermissionsUseCase implements IUseCase {
    private readonly logger = createLogger(GetPermissionsUseCase.name);
    constructor(private readonly abilityFactory: PermissionsAbilityFactory) {}

    async execute(params: { user: Partial<IUser> }): Promise<{
        [K in ResourceType]?: {
            [A in Action]?: string | string[];
        };
    }> {
        const { uuid: userUuid, organization } = params.user;
        const organizationUuid = organization?.uuid;

        if (!userUuid || !organizationUuid) {
            this.logger.warn({
                message:
                    'User UUID or Organization UUID is missing in the user object',
                metadata: { params },
                context: GetPermissionsUseCase.name,
            });
            return {};
        }

        try {
            const ability = await this.abilityFactory.createForUser(
                params.user as IUser,
            );
            const permissions = this.buildPermissions(ability.rules);

            return permissions;
        } catch (error) {
            this.logger.error({
                message: 'Error getting permissions',
                error,
                context: GetPermissionsUseCase.name,
                metadata: { params },
            });
            throw error;
        }
    }

    private buildPermissions(rules: AppAbility['rules']): {
        [K in ResourceType]?: {
            [A in Action]?: string | string[];
        };
    } {
        const permissions: Map<
            ResourceType,
            Partial<Record<Action, string | string[]>>
        > = new Map();

        for (const rule of rules) {
            const resources =
                rule.subject === 'all'
                    ? Object.values(ResourceType)
                    : [rule.subject as ResourceType];
            if (!resources) continue;

            for (const resourceType of resources) {
                const subjectPermissions = permissions.get(resourceType) ?? {};
                const ruleActions = Array.isArray(rule.action)
                    ? rule.action
                    : [rule.action];

                for (const action of ruleActions) {
                    const actionKeys = this.getActionKeys(action);

                    if (rule.conditions) {
                        for (const key of actionKeys) {
                            const conditions = rule.conditions;

                            if (conditions.repoId?.['$in']) {
                                conditions.repoId = Array.isArray(
                                    conditions.repoId['$in'],
                                )
                                    ? conditions.repoId['$in']
                                    : [conditions.repoId['$in']];
                            }

                            subjectPermissions[key] = conditions as unknown as
                                | string
                                | string[];
                        }
                    }
                }

                permissions.set(resourceType, subjectPermissions);
            }
        }

        return Object.fromEntries(permissions);
    }

    private getActionKeys(action: Action): Action[] {
        return action === Action.Manage
            ? Object.values(Action)
            : [action as Action];
    }
}
