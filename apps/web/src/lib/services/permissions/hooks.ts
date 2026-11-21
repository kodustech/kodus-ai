import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { hasPermission } from "src/core/utils/permission-map";

import { Action, ResourceType } from "./types";

export const usePermission = (
    action: Action,
    resource: ResourceType,
    repoId?: string,
): boolean => {
    const { organizationId } = useAuth();
    const permissions = usePermissions();

    return hasPermission({
        permissions,
        organizationId: organizationId!,
        action,
        resource,
        repoId,
    });
};

/**
 * The permission on every one of these repositories (an action the API checks
 * on each, such as a Run of a multi-repository environment). No repository:
 * the permission at all.
 */
export const usePermissionOnEvery = (
    action: Action,
    resource: ResourceType,
    repoIds: readonly string[],
): boolean => {
    const { organizationId } = useAuth();
    const permissions = usePermissions();
    const ids = repoIds.length ? repoIds : [undefined];
    return ids.every((repoId) =>
        hasPermission({
            permissions,
            organizationId: organizationId!,
            action,
            resource,
            repoId,
        }),
    );
};
