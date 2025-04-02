import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import {
    ITeamArtifactsRepository,
    TEAM_ARTIFACTS_REPOSITORY_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.repository';
import { ITeamArtifactsService } from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { TeamArtifactsEntity } from '@/core/domain/teamArtifacts/entities/teamArtifacts.entity';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { Inject, Injectable } from '@nestjs/common';
import { ProjectManagementService } from '../platformIntegration/projectManagement.service';
import {
    getLast24hoursRange,
    getPreviousWeekRange,
} from '@/shared/utils/helpers';
import { WorkItemSkippingWIPColumnsArtifact } from './artifacts/workItemSkippingWIPColumns.artifact';
import { artifacts } from './artifactsStructure.json';
import { WipLimitArtifact } from './artifacts/wipLimit.artifact';
import { BugRatioArtifact } from './artifacts/bugRatio.artifact';
import { PinoLoggerService } from '../logger/pino.service';
import { WorkItemWithAssignedOwnerArtifact } from './artifacts/workItemWithAssignedOwner.artifact';
import { WithoutWaitingColumnsArtifact } from './artifacts/withoutWaitingColumns.artifact';
import {
    IMetricsFactory,
    METRICS_FACTORY_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { WorkItemWithClearDescriptionArtifact } from './artifacts/workItemWithClearDescription.artifact';
import { LeadTimeInWaitingColumnsArtifact } from './artifacts/leadTimeInWaitingColumns.artifact';
import * as moment from 'moment';
import { WorkItemsStoppedInWaitingColumnsArtifact } from './artifacts/workItemsStoppedInWaitingColumns.artifact';
import {
    Item,
    WorkItemType,
} from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { BlockedTimeArtifact } from './artifacts/blockedTime.artifact';
import { AnalysisType } from '@/core/domain/teamArtifacts/enums/analysIsType.enum';
import { PostStartSprintInclusionsArtifact } from './artifacts/postStartSprintInclusions.artifacts';
import { SprintSpilloverArtifact } from './artifacts/sprintSpillover.artifact';
import { ISprint } from '@/core/domain/platformIntegrations/interfaces/jiraSprint.interface';
import { DailyArtifacts } from './processArtifacts/dailyArtifacts';
import { WeeklyOrSprintArtifacts } from './processArtifacts/weeklyArtifacts';
import { HighLeadTimeInWipDeviationArtifact } from './artifacts/highLeadTimeInWipDeviation.artifact';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';
import { PullRequestWithSizeGreaterThanLimitArtifact } from './artifacts/pullRequestWithSizeGreaterThanLimit.artifact';
import { CodeReviewTimeToMergeArtifact } from './artifacts/codeReviewTimeToMerge.artifact';
import { HighWorkloadPerPersonArtifact } from './artifacts/highWorkloadPerPerson.artifact';
import { TeamMethodology } from '@/shared/domain/enums/team-methodology.enum';
import { ValidateProjectManagementIntegration } from '@/shared/utils/decorators/validate-project-management-integration.decorator';
import { ArtifactsToolType } from '@/shared/domain/enums/artifacts-tool-type.enum';

@Injectable()
export class TeamArtifactsService implements ITeamArtifactsService {
    private workItemSkippingWIPColumnsArtifact: WorkItemSkippingWIPColumnsArtifact;
    private bugRatioArtifact: BugRatioArtifact;
    private workItemWithAssignedOwnerArtifact: WorkItemSkippingWIPColumnsArtifact;
    private withoutWaitingColumnsArtifact: WithoutWaitingColumnsArtifact;
    private workItemWithClearDescriptionArtifact: WorkItemWithClearDescriptionArtifact;
    private leadTimeInWaitingColumnsArtifact: LeadTimeInWaitingColumnsArtifact;
    private workItemsStoppedInWaitingColumnsArtifact: WorkItemsStoppedInWaitingColumnsArtifact;
    private blockedTimeArtifact: BlockedTimeArtifact;
    private postStartSprintInclusionsArtifact: PostStartSprintInclusionsArtifact;
    private sprintSpilloverArtifact: SprintSpilloverArtifact;
    private highLeadTimeInWipDeviationArtifact: HighLeadTimeInWipDeviationArtifact;
    private highWorkloadPerPersonArtifact: HighWorkloadPerPersonArtifact;
    private weeklyOrSprintArtifacts: WeeklyOrSprintArtifacts;
    private dailyArtifacts: DailyArtifacts;
    private pullRequestWithSizeGreaterThanLimitArtifact: PullRequestWithSizeGreaterThanLimitArtifact;
    private codeReviewTimeToMergeArtifact: CodeReviewTimeToMergeArtifact;

    constructor(
        @Inject(TEAM_ARTIFACTS_REPOSITORY_TOKEN)
        private readonly teamArtifactsRepository: ITeamArtifactsRepository,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(METRICS_FACTORY_TOKEN)
        private readonly metricsFactory: IMetricsFactory,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly projectManagementService: ProjectManagementService,
        private readonly codeManagementService: CodeManagementService,
        private logger: PinoLoggerService,
    ) {
        this.initArtifacts();

        this.weeklyOrSprintArtifacts = new WeeklyOrSprintArtifacts(
            metricsFactory,
            TeamArtifactsService.name,
            logger,
            integrationConfigService,
            projectManagementService,
            codeManagementService,
        );

        this.dailyArtifacts = new DailyArtifacts(
            projectManagementService,
            integrationConfigService,
        );
    }

    async getMostRecentArtifactVisible(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        userId?: string,
    ): Promise<TeamArtifactsEntity[]> {
        return await this.teamArtifactsRepository.getMostRecentArtifactVisible(
            organizationAndTeamData,
            frequenceType,
            userId,
        );
    }

    create(
        teamArtifacts: Omit<ITeamArtifacts, 'uuid'>,
    ): Promise<TeamArtifactsEntity> {
        return this.teamArtifactsRepository.create(teamArtifacts);
    }

    update(
        filter: Partial<ITeamArtifacts>,
        data: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity> {
        return this.teamArtifactsRepository.update(filter, data);
    }

    bulkUpdateOfEnrichedArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        updatedData: {
            uuid: string;
            relatedData: any;
        }[],
    ): Promise<void> {
        return this.teamArtifactsRepository.bulkUpdateOfEnrichedArtifacts(
            organizationAndTeamData,
            updatedData,
        );
    }

    delete(uuid: string): Promise<void> {
        return this.teamArtifactsRepository.delete(uuid);
    }

    findById(uuid: string): Promise<TeamArtifactsEntity> {
        return this.teamArtifactsRepository.findById(uuid);
    }

    find(filter?: Partial<ITeamArtifacts>): Promise<TeamArtifactsEntity[]> {
        return this.teamArtifactsRepository.find(filter);
    }

    getNativeCollection() {
        return this.teamArtifactsRepository.getNativeCollection();
    }

    findOne(filter?: Partial<ITeamArtifacts>): Promise<TeamArtifactsEntity> {
        return this.teamArtifactsRepository.findOne(filter);
    }

    register(
        teamArtifacts: Omit<ITeamArtifacts, 'uuid'>,
    ): Promise<TeamArtifactsEntity> {
        return this.create({ ...teamArtifacts });
    }

    getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        resultType?: string,
    ): Promise<TeamArtifactsEntity[]> {
        return this.teamArtifactsRepository.getMostRecentArtifacts(
            organizationAndTeamData,
            frequenceType,
            resultType,
        );
    }

    dismissArtifact(
        artifactId: string,
        userId: string,
        organizationTeamAndData: OrganizationAndTeamData,
    ): Promise<void> {
        return this.teamArtifactsRepository.dismissArtifact(
            artifactId,
            userId,
            organizationTeamAndData,
        );
    }

    async getRecentTeamArtifactsWithPrevious(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
        resultType?: string,
        onlyCurrentDayAsRecent: boolean = false,
    ): Promise<{
        mostRecentArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        };
        previousArtifacts: {
            date: string;
            artifacts: Partial<TeamArtifactsEntity>[];
        }[];
    }> {
        // Fetch artifacts using the repository
        const artifacts: TeamArtifactsEntity[] =
            await this.teamArtifactsRepository.getTeamArtifactsByWeeksLimit(
                organizationAndTeamData,
                weeksLimit,
                frequenceType,
            );

        if (!artifacts?.length) {
            return {
                mostRecentArtifacts: {
                    date: '',
                    artifacts: [],
                },
                previousArtifacts: [],
            };
        }

        // Processes the artifacts to organize them according to the desired structure
        const groupedByDate: { [date: string]: TeamArtifactsEntity[] } =
            artifacts.reduce((acc, artifact) => {
                const date = moment(artifact.analysisFinalDate).format(
                    'YYYY-MM-DD',
                );
                if (!acc[date]) {
                    acc[date] = [];
                }
                acc[date].push(artifact);
                return acc;
            }, {});

        const sortedDates = Object.keys(groupedByDate).sort(
            (a, b) => new Date(b).getTime() - new Date(a).getTime(),
        );

        let mostRecentArtifacts;
        let mostRecentDate: string = sortedDates[0];
        let slicePreviousArtifacts: number = 1;

        if (onlyCurrentDayAsRecent) {
            if (!moment(sortedDates[0]).isSame(moment(), 'day')) {
                mostRecentDate = null;
                slicePreviousArtifacts = 0;
            }
        }

        if (mostRecentDate) {
            mostRecentArtifacts = {
                date: mostRecentDate,
                artifacts: groupedByDate[mostRecentDate].map((artifact) => {
                    return {
                        name: artifact.name,
                        description: artifact.description,
                        criticality: artifact.criticality,
                        category: artifact.category,
                        resultType: artifact.resultType,
                        howIsIdentified: artifact.howIsIdentified,
                        whyIsImportant: artifact.whyIsImportant,
                        impactArea: artifact.impactArea,
                        impactDataRelationship:
                            artifact?.impactDataRelationship,
                        analysisFinalDate: artifact.analysisFinalDate,
                        frequenceType: artifact.frequenceType,
                        additionalData: artifact.additionalData,
                        relatedData: artifact?.relatedData,
                    };
                }),
            };
        }

        // All other artifacts are considered previous
        const previousArtifacts = sortedDates
            .slice(slicePreviousArtifacts)
            .map((date) => ({
                date: date,
                artifacts: groupedByDate[date].map((artifact) => {
                    return {
                        name: artifact.name,
                        description: artifact.description,
                        criticality: artifact.criticality,
                        category: artifact.category,
                        resultType: artifact.resultType,
                        howIsIdentified: artifact.howIsIdentified,
                        whyIsImportant: artifact.whyIsImportant,
                        impactArea: artifact.impactArea,
                        impactDataRelationship:
                            artifact?.impactDataRelationship,
                        analysisFinalDate: artifact.analysisFinalDate,
                        frequenceType: artifact.frequenceType,
                        additionalData: artifact.additionalData,
                        relatedData: artifact?.relatedData,
                    };
                }),
            }));

        // Returns the structured object with MostRecentArtifacts and PreviousArtifacts
        return {
            mostRecentArtifacts,
            previousArtifacts,
        };
    }

    @ValidateProjectManagementIntegration()
    async executeDaily(organizationAndTeamData: OrganizationAndTeamData) {
        try {
            const period = getLast24hoursRange();

            const result = await this.processData(
                organizationAndTeamData,
                period,
                AnalysisType.DAILY,
            );

            if (!result) {
                return;
            }

            const {
                last24HoursTasksDefault,
                columns,
                wipColumns,
                waitingColumns,
                allWipTasks,
                bugTypeIdentifiers,
                workItemTypes,
            } = result;

            for (const artifact of await this.filterArtifactsToUse(
                'daily',
                organizationAndTeamData,
            )) {
                const artifactResult = this.artifactSelector(
                    artifact.name,
                ).execute({
                    team: { uuid: organizationAndTeamData.teamId },
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    artifact,
                    workItems: last24HoursTasksDefault,
                    //teamMembers,
                    columns,
                    wipColumns,
                    period,
                    waitingColumns,
                    frequenceType: 'daily',
                    allWipTasks,
                    bugTypeIdentifiers,
                    workItemTypes,
                });

                if (!artifactResult) {
                    continue;
                }

                this.teamArtifactsRepository.create(artifactResult);
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing teamArtifacts',
                context: TeamArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    async executeWeekly(
        organizationAndTeamData: OrganizationAndTeamData,
        artifactsToolType: ArtifactsToolType,
    ) {
        try {
            if (artifactsToolType === ArtifactsToolType.PROJECT_MANAGEMENT) {
                await this.executeWeeklyProjectManagementArtifacts(
                    organizationAndTeamData,
                );
            } else if (
                artifactsToolType === ArtifactsToolType.CODE_MANAGEMENT
            ) {
                await this.executeWeeklyCodeManagementArtifacts(
                    organizationAndTeamData,
                );
            } else {
                await Promise.all([
                    this.executeWeeklyProjectManagementArtifacts(
                        organizationAndTeamData,
                    ),
                    this.executeWeeklyCodeManagementArtifacts(
                        organizationAndTeamData,
                    ),
                ]);
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing teamArtifacts',
                context: TeamArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    private async executeWeeklyProjectManagementArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            let pullRequestsWithFiles;
            let pullRequestsForRTTM;

            const period = getPreviousWeekRange();

            const result = await this.processData(
                organizationAndTeamData,
                period,
                AnalysisType.WEEKLY,
            );

            if (!result) {
                return;
            }

            const {
                workItemsDefault,
                columns,
                wipColumns,
                waitingColumns,
                metrics,
                sprints,
                nextSprintWorkItems,
                bugTypeIdentifiers,
                workItemTypes,
            } = result;

            for (const artifact of await this.filterArtifactsToUse(
                'weekly',
                organizationAndTeamData,
            )) {
                const artifactResult = this.artifactSelector(
                    artifact.name,
                ).execute({
                    team: { uuid: organizationAndTeamData.teamId },
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    artifact,
                    workItems: workItemsDefault,
                    columns,
                    wipColumns,
                    period,
                    waitingColumns,
                    metrics,
                    frequenceType: 'weekly',
                    sprints,
                    nextSprintWorkItems,
                    bugTypeIdentifiers,
                    workItemTypes,
                    pullRequestsWithFiles,
                    pullRequestsForRTTM,
                });

                if (!artifactResult) {
                    continue;
                }

                this.teamArtifactsRepository.create(artifactResult);
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing teamArtifacts',
                context: TeamArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    private async executeWeeklyCodeManagementArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const period = getPreviousWeekRange();

            const pullRequestsWithFiles =
                await this.codeManagementService.getPullRequestsWithFiles({
                    organizationAndTeamData,
                    filters: {
                        period,
                    },
                });

            const pullRequestsForRTTM =
                await this.codeManagementService.getPullRequestsForRTTM({
                    organizationAndTeamData,
                    filters: {
                        period,
                    },
                });

            for (const artifact of await this.filterArtifactsToUse(
                'weekly',
                organizationAndTeamData,
            )) {
                const artifactResult = this.artifactSelector(
                    artifact.name,
                ).execute({
                    team: { uuid: organizationAndTeamData.teamId },
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    artifact,
                    period,
                    frequenceType: 'weekly',
                    pullRequestsWithFiles,
                    pullRequestsForRTTM,
                });

                if (!artifactResult) {
                    continue;
                }

                this.teamArtifactsRepository.create(artifactResult);
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing teamArtifacts',
                context: TeamArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
            throw error;
        }
    }

    @ValidateProjectManagementIntegration()
    async executeForSprint(
        organizationAndTeamData: OrganizationAndTeamData,
        period: {
            startDate: string;
            endDate: string;
        },
    ) {
        try {
            const result = await this.processData(
                organizationAndTeamData,
                period,
                AnalysisType.SPRINT,
            );

            if (!result) {
                return;
            }

            const {
                workItemsDefault,
                columns,
                wipColumns,
                waitingColumns,
                metrics,
                sprints,
                nextSprintWorkItems,
            } = result;

            const artifacts = [];

            for (const artifact of await this.filterArtifactsToUse(
                'weekly',
                organizationAndTeamData,
            )) {
                const artifactResult = this.artifactSelector(
                    artifact.name,
                ).execute({
                    team: { uuid: organizationAndTeamData.teamId },
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                    artifact,
                    workItems: workItemsDefault,
                    columns,
                    wipColumns,
                    period,
                    waitingColumns,
                    metrics,
                    frequenceType: 'sprint',
                    sprints,
                    nextSprintWorkItems,
                });

                if (!artifactResult) continue;

                artifacts.push(artifactResult);
            }

            return artifacts;
        } catch (error) {
            this.logger.error({
                message: 'Error executing teamArtifacts',
                context: TeamArtifactsService.name,
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                },
            });
        }
    }

    private async processData(
        organizationAndTeamData: OrganizationAndTeamData,
        period: { startDate: string; endDate: string },
        analysisType: AnalysisType,
    ) {
        const columns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.COLUMNS_MAPPING, organizationAndTeamData);

        const waitingColumns =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                ColumnsConfigKey[]
            >(IntegrationConfigKey.WAITING_COLUMNS, organizationAndTeamData);

        const wipColumns = columns
            .filter(
                (columnConfig: ColumnsConfigKey) =>
                    columnConfig.column === 'wip',
            )
            .map((columnConfig) => {
                return { id: columnConfig.id, name: columnConfig.name };
            });

        const doneColumn = columns
            .filter(
                (columnConfig: ColumnsConfigKey) =>
                    columnConfig.column === 'done',
            )
            .map((columnConfig) => {
                return { id: columnConfig.id, name: columnConfig.name };
            });

        const statusesIds = wipColumns
            .map((wipColumn) => wipColumn.id)
            .concat(doneColumn.map((doneColumn) => doneColumn.id));

        const bugTypeIdentifiers =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Partial<WorkItemType>[]
            >(
                IntegrationConfigKey.BUG_TYPE_IDENTIFIERS,
                organizationAndTeamData,
            );

        if (analysisType === AnalysisType.DAILY) {
            const { last24HoursTasksDefault, allWipTasks, workItemTypes } =
                await this.dailyArtifacts.processData(
                    organizationAndTeamData,
                    period,
                    wipColumns,
                );

            return {
                last24HoursTasksDefault,
                columns,
                wipColumns,
                waitingColumns,
                allWipTasks,
                workItemTypes,
            };
        }

        const teamMethodology =
            await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                organizationAndTeamData,
            );

        const sprints: { currentSprint?: ISprint; nextSprint?: ISprint } = {
            currentSprint: null,
            nextSprint: null,
        };

        let nextSprintWorkItems: Item[] = [];

        if (teamMethodology.toLowerCase() === TeamMethodology.SCRUM) {
            sprints.currentSprint =
                await this.projectManagementService.getCurrentSprintForTeam({
                    organizationAndTeamData,
                });

            sprints.nextSprint =
                await this.projectManagementService.getNextSprintForTeam({
                    organizationAndTeamData,
                    currentSprintId: sprints.currentSprint.id,
                });

            const workItemTypesDefault =
                await this.projectManagementService.getWorkItemsTypes(
                    organizationAndTeamData,
                    MODULE_WORKITEMS_TYPES.DEFAULT,
                );

            nextSprintWorkItems =
                await this.projectManagementService.getWorkItemsBySprint({
                    organizationAndTeamData,
                    projectManagementSprintId: sprints?.nextSprint?.id,
                    filters: {
                        movementFilter: (item) => item.field !== 'description',
                        workItemTypes: workItemTypesDefault,
                        expandChangelog: true,
                    },
                });
        }

        const {
            workItemsDefault,
            metrics,
            workItemTypes,
            //commitsByUser,
        } = await this.weeklyOrSprintArtifacts.processData(
            organizationAndTeamData,
            period,
            analysisType,
            statusesIds,
            teamMethodology,
            bugTypeIdentifiers,
        );

        return {
            workItemsDefault,
            metrics,
            columns,
            wipColumns,
            waitingColumns,
            sprints,
            nextSprintWorkItems,
            bugTypeIdentifiers,
            workItemTypes,
        };
    }

    private async filterArtifactsToUse(
        frequenceType: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const teamArtifactsFromParameters = (
            await this.parametersService.findByKey(
                ParametersKey.TEAM_ARTIFACTS_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;

        const artifactsFiltered = artifacts.filter(
            (artifact) =>
                artifact.status &&
                artifact.frequenceTypes?.includes(frequenceType) &&
                teamArtifactsFromParameters?.some(
                    (ta) => ta.name === artifact.name && ta.status,
                ),
        );

        const mergedArtifacts =
            artifactsFiltered?.map((artifact) => ({
                ...artifact,
                artifactConfigs:
                    teamArtifactsFromParameters?.find(
                        (artifactParam) =>
                            artifactParam.name === artifact.name &&
                            artifact.status,
                    )?.artifactConfigs || {},
            })) || [];

        return mergedArtifacts;
    }

    getTeamArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        type: string = 'weekly',
    ): Promise<TeamArtifactsEntity[]> {
        if (type === 'all') {
            return this.teamArtifactsRepository.getTeamArtifactsByWeeksLimit(
                organizationAndTeamData,
                weeksLimit,
            );
        } else {
            return this.teamArtifactsRepository.getTeamArtifactsByWeeksLimit(
                organizationAndTeamData,
                weeksLimit,
                type,
            );
        }
    }

    private artifactSelector(name: string) {
        const result = {
            //WIPLimit: this.wipLimitArtifact,
            WorkItemSkippingWIPColumns: this.workItemSkippingWIPColumnsArtifact,
            BugRatio: this.bugRatioArtifact,
            WorkItemWithAssignedOwner: this.workItemWithAssignedOwnerArtifact,
            WithoutWaitingColumns: this.withoutWaitingColumnsArtifact,
            WorkItemWithClearDescription:
                this.workItemWithClearDescriptionArtifact,
            LeadTimeInWaitingColumns: this.leadTimeInWaitingColumnsArtifact,
            WorkItemsStoppedInWaitingColumns:
                this.workItemsStoppedInWaitingColumnsArtifact,
            BlockedTime: this.blockedTimeArtifact,
            PostStartSprintInclusions: this.postStartSprintInclusionsArtifact,
            SprintSpillover: this.sprintSpilloverArtifact,
            HighLeadTimeInWipDeviation: this.highLeadTimeInWipDeviationArtifact,
            PullRequestWithSizeGreaterThanLimit:
                this.pullRequestWithSizeGreaterThanLimitArtifact,
            CodeReviewTimeToMerge: this.codeReviewTimeToMergeArtifact,
            HighWorkloadPerPerson: this.highWorkloadPerPersonArtifact,
        };

        return result[name];
    }

    private initArtifacts() {
        this.workItemSkippingWIPColumnsArtifact =
            new WorkItemSkippingWIPColumnsArtifact();
        //this.wipLimitArtifact = new WipLimitArtifact();
        this.bugRatioArtifact = new BugRatioArtifact();
        this.workItemWithAssignedOwnerArtifact =
            new WorkItemWithAssignedOwnerArtifact();
        this.withoutWaitingColumnsArtifact =
            new WithoutWaitingColumnsArtifact();
        this.workItemWithClearDescriptionArtifact =
            new WorkItemWithClearDescriptionArtifact();
        this.leadTimeInWaitingColumnsArtifact =
            new LeadTimeInWaitingColumnsArtifact();
        this.workItemsStoppedInWaitingColumnsArtifact =
            new WorkItemsStoppedInWaitingColumnsArtifact();
        this.blockedTimeArtifact = new BlockedTimeArtifact();
        this.postStartSprintInclusionsArtifact =
            new PostStartSprintInclusionsArtifact();
        this.sprintSpilloverArtifact = new SprintSpilloverArtifact();
        this.highLeadTimeInWipDeviationArtifact =
            new HighLeadTimeInWipDeviationArtifact();
        this.pullRequestWithSizeGreaterThanLimitArtifact =
            new PullRequestWithSizeGreaterThanLimitArtifact();
        this.codeReviewTimeToMergeArtifact =
            new CodeReviewTimeToMergeArtifact();
        this.highWorkloadPerPersonArtifact =
            new HighWorkloadPerPersonArtifact();
    }
}
