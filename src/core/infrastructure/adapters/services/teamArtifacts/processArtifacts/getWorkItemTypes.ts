import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IIntegrationConfigService } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { ModuleWorkItemType } from '@/core/domain/integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';

export const getWorkItemsTypes = async (
    organizationAndTeamData: OrganizationAndTeamData,
    integrationConfigService: IIntegrationConfigService,
) => {
    const workItemTypes =
        await integrationConfigService.findIntegrationConfigFormatted<
            ModuleWorkItemType[]
        >(IntegrationConfigKey.MODULE_WORKITEMS_TYPES, organizationAndTeamData);

    const workItemTypesDefault = workItemTypes.find(
        (workItemType) => workItemType.name === MODULE_WORKITEMS_TYPES.DEFAULT,
    ).workItemTypes;

    const workItemTypesImproveTaskDescription = workItemTypes.find(
        (workItemType) =>
            workItemType.name ===
            MODULE_WORKITEMS_TYPES.IMPROVE_TASK_DESCRIPTION,
    ).workItemTypes;

    return {
        workItemTypesDefault,
        workItemTypesImproveTaskDescription,
        workItemTypes,
    };
};
