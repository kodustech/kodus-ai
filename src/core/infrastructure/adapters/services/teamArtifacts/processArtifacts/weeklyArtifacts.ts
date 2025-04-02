import { IMetricsFactory } from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AnalysisType } from '@/core/domain/teamArtifacts/enums/analysIsType.enum';
import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { getWorkItemsTypes } from './getWorkItemTypes';
import { IIntegrationConfigService } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { getWorkItems } from './getWorkItems';
import { ProjectManagementService } from '../../platformIntegration/projectManagement.service';
import { PinoLoggerService } from '../../logger/pino.service';
import { CodeManagementService } from '../../platformIntegration/codeManagement.service';
import { OrganizationAndTeamDataDto } from '@/core/infrastructure/http/dtos/organizationAndTeamData.dto';
import { IMembers } from '@/core/domain/teamMembers/interfaces/team-members.interface';
import { MetricsConversionStructure } from '@/shared/domain/interfaces/metrics';

export class WeeklyOrSprintArtifacts {
    constructor(
        private metricsFactory: IMetricsFactory,
        private teamArtifactsServiceName: string,
        private logger: PinoLoggerService,
        private integrationConfigService: IIntegrationConfigService,
        private projectManagementService: ProjectManagementService,
        private codeManagementService: CodeManagementService,
    ) {}

    async processData(
        organizationAndTeamData: OrganizationAndTeamData,
        period: { startDate: string; endDate: string },
        analysisType: AnalysisType,
        statusesIds,
        teamMethodology?: string,
        bugTypeIdentifiers?: Partial<WorkItemType>[],
    ) {
        try {
            const metrics =
                await this.metricsFactory.getFlowMetricsHistoryWithConfigurableParams(
                    organizationAndTeamData,
                    MetricsConversionStructure.I_METRICS,
                    {
                        howManyMetricsInThePast: 0,
                    },
                );

            if (!metrics) {
                this.logger.warn({
                    message:
                        'No metrics found for the team (Maybe the team has no integration or there is an issue)',
                    context: this.teamArtifactsServiceName,
                    metadata: {
                        teamId: organizationAndTeamData.teamId,
                        organizationId: organizationAndTeamData.organizationId,
                    },
                });
                return;
            }

            const workItems = await getWorkItems(
                this.projectManagementService,
                analysisType,
                organizationAndTeamData,
                statusesIds,
                period,
                teamMethodology,
            );

            const {
                workItemTypesDefault,
                workItemTypesImproveTaskDescription,
                workItemTypes,
            } = await getWorkItemsTypes(
                organizationAndTeamData,
                this.integrationConfigService,
            );

            const workItemsDefault = workItems.filter((issue) => {
                return workItemTypesDefault.some((workItemType) => {
                    return (
                        workItemType.id === issue.workItemType.id ||
                        workItemType.name === issue.workItemType.name
                    );
                });
            });

            return {
                workItemsDefault,
                metrics,
                bugTypeIdentifiers,
                workItemTypes,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing team metrics',
                context: this.teamArtifactsServiceName,
                error: error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            return;
        }
    }

    private async getCommitsByUsersAndPeriod(
        teamMembers: IMembers[],
        period: { startDate: string; endDate: string },
        organizationAndTeamData: OrganizationAndTeamDataDto,
    ) {
        const filters = {
            startDate: new Date(
                new Date(period.endDate).setDate(
                    new Date(period.endDate).getDate() - 30,
                ),
            )
                .toISOString()
                .slice(0, 16),
            endDate: period.endDate,
        };

        const commits = await this.codeManagementService.getCommits({
            filters,
            organizationAndTeamData,
        });

        if (commits?.length === 0) {
            return [];
        }

        const commitsByUser = {};

        teamMembers.forEach((member) => {
            commitsByUser[member?.codeManagement?.id] = {
                id: member?.codeManagement?.id?.toString(),
                name: member?.name,
                codeManagementName: member?.codeManagement?.name,
                commits: [],
            };
        });

        commits.forEach((item) => {
            let found = false;

            if (
                item.commit.author.id &&
                commitsByUser.hasOwnProperty(item.commit.author.id)
            ) {
                commitsByUser[item.commit.author.id].commits.push({
                    id: item.sha,
                    authorId: item.commit.author.id,
                    authorName: item.commit.author.name,
                    createdAt: item.commit.author.date,
                    message: item.commit.message,
                });
                found = true;
            }

            if (!found) {
                for (let userId in commitsByUser) {
                    if (
                        commitsByUser[userId].codeManagementName ===
                        item.commit.author.id
                    ) {
                        commitsByUser[userId].commits.push({
                            id: item.sha,
                            authorId: item.commit.author.id,
                            authorName: item.commit.author.name,
                            createdAt: item.commit.author.date,
                            message: item.commit.message,
                        });
                        break;
                    }
                }
            }
        });

        const groupedCommits = Object.values(commitsByUser);

        return groupedCommits;
    }
}
