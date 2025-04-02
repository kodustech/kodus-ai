import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AnalysisType } from '@/core/domain/teamArtifacts/enums/analysIsType.enum';
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';

export const getWorkItems = async (
    projectManagementService: ProjectManagementService,
    analysisType: AnalysisType,
    organizationAndTeamData: OrganizationAndTeamData,
    statusesIds,
    period,
    teamMethodology,
): Promise<Item[]> => {
    const workItemTypesDefault =
        await projectManagementService.getWorkItemsTypes(
            organizationAndTeamData,
            MODULE_WORKITEMS_TYPES.DEFAULT,
        );

    if (
        analysisType === AnalysisType.SPRINT ||
        teamMethodology.toLowerCase() === 'scrum'
    ) {
        return await projectManagementService.getWorkItemsByCurrentSprint({
            organizationAndTeamData: organizationAndTeamData,
            filters: {
                statusesIds,
                period,
                movementFilter: (item) => item.field !== 'description',
                workItemTypes: workItemTypesDefault,
            },
        });
    }

    return await projectManagementService.getAllIssuesInWIPOrDoneMovementByPeriod(
        {
            organizationAndTeamData,
            filters: {
                statusesIds,
                period,
                movementFilter: (item) => item.field !== 'description',
                workItemTypes: workItemTypesDefault,
                expandChangelog: true,
                showDescription: true,
            },
        },
    );
};
