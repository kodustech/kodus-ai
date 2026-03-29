import { UserRole } from '@enums';
import {
    Action,
    type PermissionsMap,
    ResourceType,
} from '@services/permissions/types';
import { hasPermission } from 'src/core/utils/permission-map';
import type { BYOKConfig } from './_types';
import type { OrganizationLicense } from '../subscription/_services/billing/types';

export const isBYOKSubscriptionPlan = (license: OrganizationLicense) => {
    if (
        license.subscriptionStatus === 'self-hosted' ||
        license.subscriptionStatus === 'licensed-self-hosted'
    ) {
        return true;
    }
    if (license.subscriptionStatus !== 'active') {
        return false;
    }
    return license.planType.includes('byok');
};

export const shouldShowBYOKMissingKeyTopbar = (params: {
    license: OrganizationLicense | null;
    byokConfig:
        | {
              main?: BYOKConfig;
              fallback?: BYOKConfig;
          }
        | null
        | undefined;
    permissions: PermissionsMap;
    organizationId: string;
    role?: UserRole;
}) => {
    const { license, byokConfig, permissions, organizationId, role } = params;

    if (!license || byokConfig?.main || !isBYOKSubscriptionPlan(license)) {
        return false;
    }

    if (role === UserRole.OWNER) {
        return true;
    }

    return hasPermission({
        permissions,
        organizationId,
        action: Action.Update,
        resource: ResourceType.OrganizationSettings,
    });
};
