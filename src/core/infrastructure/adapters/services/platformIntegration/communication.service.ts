import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { Channel } from '@/core/domain/platformIntegrations/types/communication/channel.type';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { PlatformIntegrationFactory } from './platformIntegration.factory';
import { extractOrganizationAndTeamData } from '@/shared/utils/helpers';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CommunicationManagementConnectionStatus } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';

@Injectable()
export class CommunicationService {
    constructor(
        @Inject(forwardRef(() => INTEGRATION_SERVICE_TOKEN))
        private readonly integrationService: IIntegrationService,
        private platformIntegrationFactory: PlatformIntegrationFactory,
        @Inject(forwardRef(() => INTEGRATION_CONFIG_SERVICE_TOKEN))
        private integrationConfigService: IIntegrationConfigService,
    ) {}

    async getTypeIntegrationByTeamId(
        teamId: string,
    ): Promise<{ type: PlatformType; integrationId: string }> {
        const integrationConfig = await this.integrationConfigService.findOne({
            configKey: IntegrationConfigKey.CHANNEL_INFO,
            team: { uuid: teamId },
        });

        const integration = await this.integrationService.findById(
            integrationConfig.integration.uuid,
        );

        if (!integration) {
            return null;
        }

        return { type: integration.platform, integrationId: integration.uuid };
    }

    async getTypeIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PlatformType> {
        try {
            const integration = await this.integrationService.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData?.teamId },
                integrationCategory: IntegrationCategory.COMMUNICATION,
                status: true,
            });

            if (!integration) {
                return null;
            }

            return integration.platform;
        } catch (error) {
            console.log(error);
        }
    }

    async getChannel(params: any, type?: PlatformType): Promise<Channel[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.getChannel(params);
    }

    async getListMembers(params: any, type?: PlatformType): Promise<Channel[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.getListMembers(params);
    }

    async verifyConnection(
        params: any,
        type?: PlatformType,
    ): Promise<CommunicationManagementConnectionStatus> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.verifyConnection(params);
    }

    async newMessagesToProjectLeader(
        params: any,
        type?: PlatformType,
    ): Promise<{ success: boolean; message: string }> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.newMessagesToProjectLeader(params);
    }

    async sendInsightMessage(
        params: any,
        type?: PlatformType,
    ): Promise<{ success: boolean; message: string }> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.sendInsightMessage(params);
    }

    async handlerTemplateMessage(
        params: any,
        type?: PlatformType,
    ): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.handlerTemplateMessage(params);
    }

    async newBlockMessage(params: any, type?: PlatformType): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.newBlockMessage(params);
    }

    async newTextMessage(params: any, type?: PlatformType): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.newTextMessage(params);
    }

    async getChannelIdLeaderTeam(
        params: any,
        type?: PlatformType,
    ): Promise<{ id: string; name: string }[]> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.getChannelIdLeaderTeam(params);
    }

    async getTeamChannelId(params: any, type?: PlatformType): Promise<any> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.getTeamChannelId(params);
    }

    async createAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.createAuthIntegration(params);
    }

    async updateAuthIntegration(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.updateAuthIntegration(params);
    }

    async createOrUpdateIntegrationConfig(
        params: any,
        type?: PlatformType,
    ): Promise<void> {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.createOrUpdateIntegrationConfig(params);
    }

    async saveChannelSelected(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.saveChannelSelected(params);
    }

    private async getServiceAndType(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }
        return {
            type,
            service:
                this.platformIntegrationFactory.getCommunicationService(type),
        };
    }

    async saveCheckinHistory(params: any, type?: PlatformType) {
        const { service } = await this.getServiceAndType(params, type);

        return service.saveCheckinHistory(params);
    }

    async saveCheckinHistoryOrganization(params: any, type?: PlatformType) {
        const { service } = await this.getServiceAndType(params, type);

        return service.saveCheckinHistoryOrganization(params);
    }

    async formatKodyNotification(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.formatKodyNotification(params);
    }

    async formatMetricsMessage(params: any, type?: PlatformType) {
        if (!type) {
            type = await this.getTypeIntegration(
                extractOrganizationAndTeamData(params),
            );
        }

        if (!type) return null;

        const communicationService =
            this.platformIntegrationFactory.getCommunicationService(type);

        return communicationService.formatMetricsMessage(params);
    }
}
