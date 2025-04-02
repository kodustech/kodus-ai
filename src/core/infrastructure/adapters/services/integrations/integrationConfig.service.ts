import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigRepository,
    INTEGRATION_CONFIG_REPOSITORY_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.repository.contracts';
import { IIntegrationConfigService } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@/core/domain/integrationConfigs/entities/integration-config.entity';
import { IIntegrationConfig } from '@/core/domain/integrationConfigs/interfaces/integration-config.interface';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isString } from 'class-validator';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class IntegrationConfigService implements IIntegrationConfigService {
    constructor(
        @Inject(INTEGRATION_CONFIG_REPOSITORY_TOKEN)
        private readonly integrationConfigRepository: IIntegrationConfigRepository,
    ) {}

    savePrivateChannel(params: any): Promise<void> {
        return this.integrationConfigRepository.savePrivateChannel(params);
    }

    findOneIntegrationConfigWithIntegrations(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findOneIntegrationConfigWithIntegrations(
            configKey,
            organizationAndTeamData,
        );
    }

    find(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.find(filter);
    }

    findOne(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findOne(filter);
    }

    findByOrganizationName(
        organizationName: string,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findByOrganizationName(
            organizationName,
        );
    }

    findByInstallId(installId: string): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findByInstallId(installId);
    }

    findById(uuid: string): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findById(uuid);
    }

    findIntegrationConfigWithTeams(
        configKey: IntegrationConfigKey,
        repositoryId: string,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.findIntegrationConfigWithTeams(
            configKey,
            repositoryId,
        );
    }

    create(
        integrationConfig: IIntegrationConfig,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.create(integrationConfig);
    }

    update(
        filter: Partial<IIntegrationConfig>,
        data: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.integrationConfigRepository.delete(uuid);
    }

    async createOrUpdateConfig(
        integrationConfigKey: IntegrationConfigKey,
        payload: any,
        integrationId: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity> {
        try {
            if (!integrationId) {
                return null;
            }

            const integrationConfig = await this.findOne({
                integration: { uuid: integrationId },
                team: { uuid: organizationAndTeamData.teamId },
                configKey: integrationConfigKey,
            });

            if (!integrationConfig) {
                const uuid = uuidv4();

                return this.create({
                    uuid: uuid,
                    configKey: integrationConfigKey,
                    configValue: payload,
                    integration: { uuid: integrationId },
                    team: { uuid: organizationAndTeamData.teamId },
                });
            } else {
                this.update(
                    {
                        uuid: integrationConfig?.uuid,
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                    {
                        configKey: integrationConfigKey,
                        configValue: payload,
                        integration: { uuid: integrationId },
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                );
            }
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findIntegrationConfigFormatted<T>(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T> {
        try {
            const data = await this.findOneIntegrationConfigWithIntegrations(
                configKey,
                organizationAndTeamData,
            );

            if (!data?.configValue) {
                return null;
            }

            // Checks if the payload is an array and returns it as such
            if (Array.isArray(data.configValue)) {
                return [...data.configValue] as T;
            }

            if (isString(data.configValue)) {
                return data.configValue as T;
            }

            // If it's not an array, return it as an object
            return { ...data.configValue } as T;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
}
