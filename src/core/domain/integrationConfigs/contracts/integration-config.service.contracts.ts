import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IIntegrationConfigRepository } from './integration-config.repository.contracts';
import { IntegrationConfigEntity } from '../entities/integration-config.entity';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const INTEGRATION_CONFIG_SERVICE_TOKEN = Symbol(
    'IntegrationConfigService',
);

export interface IIntegrationConfigService
    extends IIntegrationConfigRepository {
    createOrUpdateConfig(
        integrationConfigKey: IntegrationConfigKey,
        payload: any,
        integrationId: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity>;
    findIntegrationConfigFormatted<T>(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T>;
    savePrivateChannel(params: any): Promise<void>;
}
