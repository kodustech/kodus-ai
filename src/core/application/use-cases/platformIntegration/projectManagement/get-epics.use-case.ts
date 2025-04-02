import { STATUS } from '@/config/types/database/status.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ColumnsConfigResult } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetEpicsUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamsService: ITeamService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly projectManagementService: ProjectManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(teamId: string | null) {
        try {
            const organizationId = this.request.user.organization.uuid;
            const teams = await this.getTeams(organizationId, teamId);

            if (!teams || teams?.length <= 0) {
                return [];
            }

            const epicsResult = await this.processTeams(teams, organizationId);
            return epicsResult.flat();
        } catch (error) {
            this.logger.error({
                message: 'Error while retrieving epics',
                context: GetEpicsUseCase.name,
                serviceName: 'GetEpicsUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                    teamId: teamId,
                },
            });
        }
    }

    private async getTeams(organizationId: string, teamId: string) {
        const teamQuery = teamId
            ? { uuid: teamId, organization: { uuid: organizationId } }
            : { organization: { uuid: organizationId } };

        return this.teamsService.find(teamQuery, [STATUS.ACTIVE]);
    }

    private async processTeams(teams, organizationId: string) {
        return Promise.all(
            teams.map(async (team) => {
                const organizationAndTeamData = {
                    organizationId,
                    teamId: team.uuid,
                };

                const [
                    metrics,
                    columnsConfig,
                    teamMethodology,
                    epicsAndLinkedItems,
                ] = await Promise.all([
                    this.metricsFactory.getRealTime(organizationAndTeamData),
                    this.projectManagementService.getColumnsConfig(
                        organizationAndTeamData,
                    ),
                    this.integrationConfigService.findIntegrationConfigFormatted<string>(
                        IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                        organizationAndTeamData,
                    ),
                    this.projectManagementService.getEpicsAndLinkedItems({
                        organizationAndTeamData,
                    }),
                ]);

                return this.processEpics(
                    epicsAndLinkedItems,
                    columnsConfig,
                    organizationAndTeamData,
                    metrics,
                    teamMethodology,
                    team.name,
                );
            }),
        );
    }

    private async processEpics(
        epicsAndLinkedItems,
        columnsConfig,
        organizationAndTeamData,
        metrics,
        teamMethodology,
        teamName: string,
    ) {
        const filteredEpics = this.filterEpics(
            epicsAndLinkedItems,
            columnsConfig,
        );
        return Promise.all(
            filteredEpics.map(async (epic) => {
                const epicIssues = this.filterEpicIssues(
                    epic.issues,
                    columnsConfig.allColumns,
                );
                const epicsAndLinkedItemsWIP = this.filterItemsByColumn(
                    epicIssues,
                    columnsConfig.wipColumns,
                );

                const workItemsWithDeliveryStatus =
                    await this.metricsFactory.getWorkItemsDeliveryStatus(
                        organizationAndTeamData,
                        epicsAndLinkedItemsWIP,
                        metrics,
                        columnsConfig,
                        teamMethodology,
                    );

                const progress = this.calculateStatusPercentages(
                    epicIssues,
                    columnsConfig,
                );
                const isLate = this.checkIfEpicIsAtRisk(
                    workItemsWithDeliveryStatus,
                );

                return {
                    id: epic.id,
                    key: epic.key,
                    name: epic.name,
                    teamName,
                    isLate,
                    results: [...progress],
                };
            }),
        );
    }

    private filterEpics(epicsAndLinkedItems, columnsConfig) {
        if (!epicsAndLinkedItems?.length) {
            return [];
        }

        return epicsAndLinkedItems.filter((epic) => {
            const isAnyIssueNotDone = epic.issues.some(
                (issue) => !columnsConfig.doneColumns.includes(issue.status.id),
            );

            if (isAnyIssueNotDone) {
                return true;
            }

            const doneIssuesCount = epic.issues.filter((issue) =>
                columnsConfig.doneColumns.includes(issue.status.id),
            ).length;

            return doneIssuesCount === 0;
        });
    }

    private filterEpicIssues(issues, allColumns) {
        const filteredColumns = allColumns.map(
            (columnConfig) => columnConfig.id,
        );
        return (
            issues?.filter((item) =>
                filteredColumns.includes(item.status.id),
            ) ?? []
        );
    }

    private filterItemsByColumn(items, columnIds) {
        return items.filter((item) => columnIds.includes(item.status.id));
    }

    private calculateStatusPercentages(
        issues,
        columnsConfig: ColumnsConfigResult,
    ) {
        const total = issues.length;

        const epicsAndLinkedItemsTODO = issues?.filter((item) =>
            columnsConfig.todoColumns.includes(item.status.id),
        );

        const epicsAndLinkedItemsWIP = issues?.filter((item) =>
            columnsConfig.wipColumns.includes(item.status.id),
        );

        const epicsAndLinkedItemsDONE = issues?.filter((item) =>
            columnsConfig.doneColumns.includes(item.status.id),
        );

        return [
            {
                todo: parseFloat(
                    ((epicsAndLinkedItemsTODO?.length / total) * 100)?.toFixed(
                        2,
                    ),
                ),
                workItems: epicsAndLinkedItemsTODO.map((issue) => ({
                    key: issue.key,
                    title: issue.name,
                    type: issue.workItemType.name,
                })),
            },
            {
                wip: parseFloat(
                    ((epicsAndLinkedItemsWIP?.length / total) * 100)?.toFixed(
                        2,
                    ),
                ),
                workItems: epicsAndLinkedItemsWIP.map((issue) => ({
                    key: issue.key,
                    title: issue.name,
                    type: issue.workItemType.name,
                })),
            },

            {
                done: parseFloat(
                    ((epicsAndLinkedItemsDONE?.length / total) * 100)?.toFixed(
                        2,
                    ),
                ),
                workItems: epicsAndLinkedItemsDONE.map((issue) => ({
                    key: issue.key,
                    title: issue.name,
                    type: issue.workItemType.name,
                })),
            },
        ];
    }

    private checkIfEpicIsAtRisk(workItemsWithDeliveryStatus): boolean {
        try {
            const RECOMENDATION_LIMIT = 0.4;

            if (!workItemsWithDeliveryStatus?.length) {
                return false;
            }

            const lateWorkItems = workItemsWithDeliveryStatus?.filter(
                (workItem) => workItem.isLate,
            );

            const latedWorkItemsResult =
                lateWorkItems?.length / workItemsWithDeliveryStatus.length;

            return latedWorkItemsResult >= RECOMENDATION_LIMIT;
        } catch (error) {
            console.log(error);
        }
    }
}
