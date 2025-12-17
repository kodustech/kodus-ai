import { STATUS } from '@/config/types/database/status.type';
import {
    Action,
    ResourceType,
    Role,
} from '@/core/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@/core/domain/permissions/types/permissions.types';
import { PolicyHandler } from '@/core/domain/permissions/types/policy.types';
import { subject as caslSubject } from '@casl/ability';

const getNestedValue = (obj: any, path: string): any => {
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
};

export const extractReposFromAbility = (
    ability: AppAbility,
    action?: Action,
    resource?: ResourceType,
): string[] => {
    const repoIds = new Set<string>();

    ability.rules.forEach((rule) => {
        if (action && rule.action !== action && rule.action !== Action.Manage) {
            return;
        }

        if (resource && rule.subject !== resource && rule.subject !== 'all') {
            return;
        }

        if (rule.conditions && rule.conditions.repoId) {
            if (Array.isArray(rule.conditions.repoId['$in'])) {
                rule.conditions.repoId['$in'].forEach((id: string) =>
                    repoIds.add(id),
                );
            }
        }
    });

    return Array.from(repoIds);
};

/**
 * Creates a policy handler that checks if the user has the specified action on the resource.
 *
 * THIS DOES NOT ENSURE REPO SCOPED PERMISSIONS, USE checkRepoPermissions OR AuthorizationService
 * FOR THAT PURPOSE.
 *
 * @param action The action to check (e.g., 'read', 'write').
 * @param resource The resource type to check (e.g., 'Issues', 'PullRequests').
 * @returns
 */
export const checkPermissions = (params: {
    action: Action;
    resource: ResourceType;
    status?: STATUS[];
}): PolicyHandler => {
    const { action, resource, status = [STATUS.ACTIVE] } = params;

    return (ability, request) => {
        if (!request.user?.organization?.uuid) {
            return false;
        }

        if (!status.includes(request.user.status)) {
            return false;
        }

        return ability.can(action, resource);
    };
};

/**
 * Creates a policy handler that checks if the user has the specified action on the resource
 * for the repository identified in the request (from params, query, body or custom).
 *
 * THIS ENSURES REPO SCOPED PERMISSIONS.
 *
 * If the provided repoId is not assigned to the user on the resource, it returns false.
 *
 * @param action The action to check (e.g., 'read', 'write').
 * @param resource The resource type to check (e.g., 'Issues', 'PullRequests').
 * @param repo An object defining where to find the repository ID in the request.
 * It can have keys for params, query, body, or a custom function/value.
 * @returns
 */
export const checkRepoPermissions = (params: {
    action: Action;
    resource: ResourceType;
    repo: {
        key?: {
            params?: string;
            query?: string;
            body?: string;
        };
        custom?: string | number | (() => string | number) | null;
    };
    status?: STATUS[];
}): PolicyHandler => {
    const { action, resource, repo, status = [STATUS.ACTIVE] } = params;

    return (ability, request) => {
        if (!request.user?.organization?.uuid) {
            return false;
        }

        if (!status.includes(request.user.status)) {
            return false;
        }

        const repoId =
            getNestedValue(request?.params, repo.key?.params || '') ||
            getNestedValue(request?.query, repo.key?.query || '') ||
            getNestedValue(request?.body, repo.key?.body || '') ||
            (typeof repo.custom === 'function' ? repo.custom() : repo.custom) ||
            null;

        if (!repoId) {
            return false;
        }

        const subject = caslSubject(resource, {
            organizationId: request.user.organization.uuid,
            repoId,
        });

        return ability.can(action, subject as any);
    };
};

export const checkRole = (params: {
    role: Role;
    status?: STATUS[];
}): PolicyHandler => {
    const { role, status = [STATUS.ACTIVE] } = params;

    return (ability, request) => {
        if (!request.user?.organization?.uuid) {
            return false;
        }

        if (!status.includes(request.user.status)) {
            return false;
        }

        return request.user.role === role;
    };
};
