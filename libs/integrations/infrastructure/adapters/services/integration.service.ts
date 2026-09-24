import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationRepository,
    INTEGRATION_REPOSITORY_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.repository.contracts';
import { IIntegrationService } from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { IIntegration } from '@libs/integrations/domain/integrations/interfaces/integration.interface';

@Injectable()
export class IntegrationService implements IIntegrationService {
    private readonly logger = createLogger(IntegrationService.name);

    constructor(
        @Inject(INTEGRATION_REPOSITORY_TOKEN)
        private readonly integrationRepository: IIntegrationRepository,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async checkConfigIntegration(
        integrationId: string,
        integrationConfigKey: IntegrationConfigKey,
    ): Promise<boolean> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integrationId },
                    configKey: integrationConfigKey,
                });

            if (!integrationConfig) {
                return false;
            }

            return !!integrationConfig?.configValue || false;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getPlatformIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        codeManagement: string;
    }> {
        try {
            const integrations = await this.find({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
            });

            if (!integrations) {
                return {
                    codeManagement: null,
                };
            }

            const integrationPlatforms = {
                codeManagement: null,
            };

            for (const item of integrations) {
                if (
                    item?.integrationCategory.toUpperCase() ===
                    IntegrationCategory.CODE_MANAGEMENT
                ) {
                    integrationPlatforms.codeManagement = item?.platform;
                }
            }

            return integrationPlatforms;
        } catch (error) {
            throw new BadRequestException(error);
        }
    }

    getFullIntegrationDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<IntegrationEntity> {
        return this.integrationRepository.getFullIntegrationDetails(
            organizationAndTeamData,
            platform,
        );
    }

    find(filter?: Partial<IIntegration>): Promise<IntegrationEntity[]> {
        return this.integrationRepository.find(filter);
    }

    findOne(filter?: Partial<IIntegration>): Promise<IntegrationEntity> {
        return this.integrationRepository.findOne(filter);
    }

    findById(uuid: string): Promise<IntegrationEntity> {
        return this.integrationRepository.findById(uuid);
    }

    create(integration: IIntegration): Promise<IntegrationEntity> {
        return this.integrationRepository.create(integration);
    }

    update(
        filter: Partial<IIntegration>,
        data: Partial<IIntegration>,
    ): Promise<IntegrationEntity> {
        return this.integrationRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.integrationRepository.delete(uuid);
    }

    async getPlatformAuthDetails<T>(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<T> {
        try {
            const integration = await this.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
                platform: platform,
            });

            if (!integration) return null;

            const authDetails = integration?.authIntegration?.authDetails || {};

            if (!authDetails) {
                return null;
            }

            return { integrationId: integration?.uuid, ...authDetails } as T;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get platform auth details',
                context: IntegrationService.name,
                error,
                metadata: { organizationAndTeamData, platform },
            });
        }
    }
}
