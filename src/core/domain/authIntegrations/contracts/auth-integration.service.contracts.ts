import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IAuthIntegrationRepository } from './auth-integration.repository.contracts';

export const AUTH_INTEGRATION_SERVICE_TOKEN = Symbol('AuthIntegrationService');

export interface IAuthIntegrationService extends IAuthIntegrationRepository {
    getPlatformAuthDetails(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
}
