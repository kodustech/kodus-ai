import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IIntegrationConfigRepository } from './integration-config.repository.contracts';
import { IntegrationConfigEntity } from '../entities/integration-config.entity';

export const INTEGRATION_CONFIG_SERVICE_TOKEN = Symbol(
    'IntegrationConfigService',
);

export interface IIntegrationConfigService extends IIntegrationConfigRepository {
    createOrUpdateConfig(
        integrationConfigKey: IntegrationConfigKey,
        payload: any,
        integrationId: any,
        organizationAndTeamData: OrganizationAndTeamData,
        type?: 'replace' | 'append',
    ): Promise<IntegrationConfigEntity>;
    findIntegrationConfigFormatted<T>(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T>;
    savePrivateChannel(params: any): Promise<void>;
    repositoryIdsListedByOtherConnections(
        organizationId: string,
        integrationId: string,
    ): Promise<Set<string>>;
}
