import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { getWorkItemsTypes } from './getWorkItemTypes';
import { IIntegrationConfigService } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';

class DailyArtifacts {
    constructor(
        private projectManagementService: ProjectManagementService,
        private integrationConfigService: IIntegrationConfigService,
    ) {}

    async processData(
        organizationAndTeamData: OrganizationAndTeamData,
        period: { startDate: string; endDate: string },
        wipColumns,
    ) {
        const {
            workItemTypesDefault,
            workItemTypes,
        } = await getWorkItemsTypes(
            organizationAndTeamData,
            this.integrationConfigService,
        );

        const last24HoursTasks =
            await this.projectManagementService.getWorkItemsForDailyCheckin(
                {
                    organizationAndTeamData,
                    filters: {
                        todayDate: new Date(period.endDate),
                        workItemTypes: workItemTypesDefault
                    },
                },
            );

        const allWipTasks =
            await this.projectManagementService.getAllWorkItemsInWIP({
                organizationAndTeamData,
                filters: {
                    statusesIds: wipColumns.map((wipColumn) => wipColumn.id),
                    workItemTypes: workItemTypesDefault,
                    expandChangelog: true,
                    showDescription: true,
                },
            });

        const last24HoursTasksDefault = last24HoursTasks.filter((issue) => {
            return workItemTypesDefault.some((workItemType) => {
                return (
                    workItemType.id === issue.workItemType.id ||
                    workItemType.name === issue.workItemType.name
                );
            });
        });

        return {
            last24HoursTasksDefault,
            allWipTasks,
            workItemTypes,
        };
    }
}

export { DailyArtifacts };
