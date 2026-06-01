import {
    Action,
    ResourceType,
    type PermissionsMap,
} from "@services/permissions/types";

export const hasPermission = (params: {
    permissions: PermissionsMap;
    organizationId: string;
    action: Action;
    resource: ResourceType;
    repoId?: string;
}) => {
    const { permissions, organizationId, action, resource, repoId } = params;

    if (!permissions || !organizationId) {
        return false;
    }

    if (permissions[ResourceType.All]?.[Action.Manage]) {
        return true;
    }

    const resourcePermissions = permissions[resource]?.[action];

    if (!resourcePermissions) {
        return false;
    }

    const matchOrgId = resourcePermissions.organizationId === organizationId;

    let matchRepoId = true;
    if (repoId && resourcePermissions.repoId) {
        matchRepoId = resourcePermissions.repoId.includes(repoId);
    }

    return matchOrgId && matchRepoId;
};
