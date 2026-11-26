import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * The part of a provider cache key that says whose answer it is. Logins,
 * user ids and repository ids repeat across servers, so two connections of
 * one provider never share an entry, nor do two workspaces that name none.
 */
export const connectionCacheScope = (
    organizationAndTeamData?: Partial<OrganizationAndTeamData> | null,
): string =>
    `${organizationAndTeamData?.organizationId ?? 'no-org'}:${
        organizationAndTeamData?.integrationId ??
        `workspace:${organizationAndTeamData?.teamId ?? 'no-team'}`
    }`;
