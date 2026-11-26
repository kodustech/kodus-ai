import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IntegrationConfigEntity } from '../entities/integration-config.entity';
import { IIntegrationConfig } from '../interfaces/integration-config.interface';

export const INTEGRATION_CONFIG_REPOSITORY_TOKEN = Symbol(
    'IntegrationConfigRepository',
);

/** One entry of a connection's repository list. */
export type RepositoryListing = {
    integrationId: string;
    repository: Record<string, unknown>;
};

export interface IIntegrationConfigRepository {
    findRepositoryListings(params: {
        teamId: string;
        integrationIds: string[];
        repository: { id?: string | number; name?: string; fullName?: string };
    }): Promise<RepositoryListing[]>;
    find(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity[]>;
    findOne(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity>;
    findById(uuid: string): Promise<IntegrationConfigEntity | undefined>;
    findByOrganizationName(
        organizationName: string,
    ): Promise<IntegrationConfigEntity | undefined>;
    findByInstallId(
        installId: string,
    ): Promise<IntegrationConfigEntity | undefined>;
    findByOrganizationAndConfigKey(
        organizationId: string,
        configKey: IntegrationConfigKey,
    ): Promise<IntegrationConfigEntity[]>;
    findOneIntegrationConfigWithIntegrations(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity>;
    /** One row per active Git connection of the workspace that has the key. */
    findAllOfTeamByConfigKey(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity[]>;
    findIntegrationConfigWithTeams(
        configKey: IntegrationConfigKey,
        repositoryId: string,
        platform: PlatformType,
    ): Promise<IntegrationConfigEntity[]>;
    create(
        integrationConfig: IIntegrationConfig,
    ): Promise<IntegrationConfigEntity | undefined>;
    update(
        filter: Partial<IIntegrationConfig>,
        data: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity | undefined>;
    delete(uuid: string): Promise<void>;
    savePrivateChannel(params: any): Promise<void>;
}
