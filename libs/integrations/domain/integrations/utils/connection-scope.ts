import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * Filter fragment that pins an integrations lookup to the Git connection a
 * call names. Empty when the caller names none, so a workspace with a single
 * connection reads it as before.
 */
export const connectionScope = (
    organizationAndTeamData?: Pick<OrganizationAndTeamData, 'integrationId'>,
): { uuid?: string } =>
    organizationAndTeamData?.integrationId
        ? { uuid: organizationAndTeamData.integrationId }
        : {};
