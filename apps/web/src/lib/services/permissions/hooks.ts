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
