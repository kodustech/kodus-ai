import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN = Symbol.for(
    'CONDITIONAL_APPROVAL_ACCESS_SERVICE_TOKEN',
);

export interface IConditionalApprovalAccessService {
    isEnabled(org: OrganizationAndTeamData): Promise<boolean>;
}
