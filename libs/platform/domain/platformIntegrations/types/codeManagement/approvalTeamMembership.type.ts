import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export type ApprovalTeamMembership = 'member' | 'not-member' | 'unavailable';

export interface ApprovalTeamMembershipParams {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    team: string;
    /** The provider login of the PR opener, including bot logins. */
    author: string;
}
