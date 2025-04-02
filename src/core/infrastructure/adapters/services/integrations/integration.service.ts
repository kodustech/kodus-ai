import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationRepository,
    INTEGRATION_REPOSITORY_TOKEN,
} from '@/core/domain/integrations/contracts/integration.repository.contracts';
import { IIntegrationService } from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@/core/domain/integrations/entities/integration.entity';
import { IIntegration } from '@/core/domain/integrations/interfaces/integration.interface';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { CommunicationService } from '../platformIntegration/communication.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class IntegrationService implements IIntegrationService {
    constructor(
        @Inject(INTEGRATION_REPOSITORY_TOKEN)
        private readonly integrationRepository: IIntegrationRepository,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly projectManagementService: ProjectManagementService,
        private readonly codeManagementService: CodeManagementService,
        private readonly communicationService: CommunicationService,
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

    async getConnections(params: any): Promise<
        {
            platformName: string;
            isSetupComplete: boolean;
            category?: IntegrationCategory;
        }[]
    > {
        try {
            const [
                communicationConnection,
                projectManagementConnection,
                codeManagementConnection,
            ] = await Promise.all([
                this.communicationService.verifyConnection(params),
                this.projectManagementService.verifyConnection(params),
                this.codeManagementService.verifyConnection(params),
            ]);

            return [
                communicationConnection,
                projectManagementConnection,
                codeManagementConnection,
            ]?.filter((connection) => connection);
        } catch (error) {
            throw new BadRequestException(error);
        }
    }

    async getPlatformIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        codeManagement: string;
        projectManagement: string;
        communication: string;
    }> {
        try {
            const integrations = await this.find({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
            });

            if (!integrations) {
                return {
                    codeManagement: null,
                    projectManagement: null,
                    communication: null,
                };
            }

            const integrationPlatforms = {
                codeManagement: null,
                projectManagement: null,
                communication: null,
            };

            for (const item of integrations) {
                if (
                    item?.integrationCategory.toUpperCase() ===
                    IntegrationCategory.CODE_MANAGEMENT
                ) {
                    integrationPlatforms.codeManagement = item?.platform;
                }

                if (
                    item?.integrationCategory.toUpperCase() ===
                    IntegrationCategory.COMMUNICATION
                ) {
                    integrationPlatforms.communication = item?.platform;
                }

                if (
                    item?.integrationCategory.toUpperCase() ===
                    IntegrationCategory.PROJECT_MANAGEMENT
                ) {
                    // This was done because in the database it is being saved in snake_case, and on the frontend, we need the information in kebab-case to be compared with integration keys
                    if (item?.platform === PlatformType.AZURE_BOARDS) {
                        integrationPlatforms.projectManagement =
                            item?.platform.replace('_', '-');
                    } else {
                        integrationPlatforms.projectManagement = item?.platform;
                    }
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
            console.log('platformkeys', error);
        }
    }
}
