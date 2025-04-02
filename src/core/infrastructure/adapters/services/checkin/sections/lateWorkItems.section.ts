import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import * as moment from 'moment-timezone';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IMetrics } from '@/core/domain/metrics/interfaces/metrics.interface';
import { TeamMethodology } from '@/shared/domain/enums/team-methodology.enum';
import { checkinTypeByFrequency } from '../utils/getCheckinType.utils';
import {
    SNOOZED_ITEMS_SERVICE_TOKEN,
    ISnoozedItemsService,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';

@Injectable()
export class LateWorkItemsSection {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        private readonly projectManagementService: ProjectManagementService,

        private readonly logger: PinoLoggerService,
    ) {}

    id() {
        return 'lateWorkItems';
    }

    name() {
        return '⌛️ Late work items';
    }

    description() {
        return 'Displays work items that are late.';
    }

    public async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        frequency: string,
        snoozedItems?: any,
    ) {
        try {
            const teamMethodology =
                await this.integrationConfigService.findIntegrationConfigFormatted<TeamMethodology>(
                    IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                    organizationAndTeamData,
                );

            const metricsRealTime = await this.metricsFactory.getRealTime({
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            });

            if (!metricsRealTime) {
                return {
                    sectionId: this.id(),
                    sectionName: this.name(),
                    sectionData: [],
                    possibleToMutate: true,
                };
            }

            const leadTimeInWip = await metricsRealTime.find(
                (metric) => metric.type === METRICS_TYPE.LEAD_TIME_IN_WIP,
            ).value?.total?.percentiles?.p75;

            const workItemsWithDeliveryStatus =
                await this.getWorkItemsWithDeliveryStatus(
                    organizationAndTeamData,
                    teamMethodology,
                    metricsRealTime,
                );

            const lateWorkItems = await this.getLateWorkItems(
                workItemsWithDeliveryStatus,
                leadTimeInWip,
            );

            const checkinType = checkinTypeByFrequency.get(frequency);

            const lateWorkItemsFiltered =
                await this.snoozedItemsService.removeFromNotification(
                    lateWorkItems,
                    this.id(),
                    snoozedItems,
                    'key',
                    checkinType,
                    organizationAndTeamData,
                );

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: lateWorkItemsFiltered,
                possibleToMutate: true,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing late work items',
                context: LateWorkItemsSection.name,
                error: error,
                metadata: { organizationAndTeamData },
            });

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: [],
                possibleToMutate: false,
            };
        }
    }

    private async getWorkItemsWithDeliveryStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMethodology: TeamMethodology,
        metricsRealTime: IMetrics[],
    ) {
        const columnsConfig =
            await this.projectManagementService.getColumnsConfig(
                organizationAndTeamData,
            );

        const workItemTypesDefault =
            await this.projectManagementService.getWorkItemsTypes(
                organizationAndTeamData,
                MODULE_WORKITEMS_TYPES.DEFAULT,
            );

        const wipWorkItems =
            await this.projectManagementService.getAllWorkItemsInWIP({
                organizationAndTeamData,
                filters: {
                    statusesIds: columnsConfig.wipColumns,
                    getDescription: false,
                    workItemTypes: workItemTypesDefault,
                },
            });

        return await this.metricsFactory.getWorkItemsDeliveryStatus(
            organizationAndTeamData,
            wipWorkItems,
            metricsRealTime,
            columnsConfig,
            teamMethodology,
        );
    }

    private async getLateWorkItems(
        workItemsWithDeliveryStatus,
        leadTimeInWipP75,
    ) {
        const lateWorkItems = [];

        const filteredLateWorkItems = workItemsWithDeliveryStatus.filter(
            (item) => item.isLate,
        );

        filteredLateWorkItems.sort((a, b) => {
            const aRank = a.rank || 0;
            const bRank = b.rank || 0;
            return aRank - bRank;
        });

        const limit =
            filteredLateWorkItems.length > 5 ? 5 : filteredLateWorkItems.length;

        for (let i = 0; i < limit; i++) {
            const item = filteredLateWorkItems[i];

            item.estimatedDeliveryDate = moment(
                item.estimatedDeliveryDate,
            ).format('DD/MM/YYYY');

            lateWorkItems.push({
                key: item.key,
                title: item.title,
                timeUsed: item.leadTimeUsedFormatted,
                projectedDeliveryDate: item.estimatedDeliveryDate,
            });
        }

        return lateWorkItems;
    }
}
