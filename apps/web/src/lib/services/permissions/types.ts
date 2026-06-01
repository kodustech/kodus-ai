import { UserRole } from "@enums";

// Single source of truth: the enums live in the backend domain layer and are
// re-exported here so the frontend can never drift from the API's contract.
import {
    Action,
    ResourceType,
} from "@libs/identity/domain/permissions/enums/permissions.enum";

export { Action, ResourceType };

export type PermissionsMap = {
    [K in ResourceType]?: {
        [A in Action]?: {
            organizationId: string;
            repoId?: string[];
        };
    };
};

export const rolePriority = {
    [UserRole.OWNER]: 1,
    [UserRole.REPO_ADMIN]: 2,
    [UserRole.BILLING_MANAGER]: 3,
    [UserRole.CONTRIBUTOR]: 4,
} as const;
