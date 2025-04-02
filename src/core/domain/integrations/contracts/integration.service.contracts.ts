import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IIntegrationRepository } from './integration.repository.contracts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const INTEGRATION_SERVICE_TOKEN = Symbol('IntegrationService');

export interface IIntegrationService extends IIntegrationRepository {
    getPlatformAuthDetails<T>(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<T>;
    getConnections(params: any): Promise<
        {
            platformName: string;
            isSetupComplete: boolean;
            category?: IntegrationCategory;
        }[]
    >;
    getPlatformIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        codeManagement: string;
        projectManagement: string;
        communication: string;
    }>;
}
