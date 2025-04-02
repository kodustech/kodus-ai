import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import { Inject, Injectable } from '@nestjs/common';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { GoodPracticeType } from '@/shared/domain/enums/good-practice-type.enum';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { CommunicationService } from '../../../platformIntegration/communication.service';
import {
    INTEGRATION_SERVICE_TOKEN,
    IIntegrationService,
} from '@/core/domain/integrations/contracts/integration.service.contracts';

import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import * as moment from 'moment';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    IIntegrationConfigService,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { ProjectManagementService } from '../../../platformIntegration/projectManagement.service';
import { JiraAuthDetail } from '@/core/domain/authIntegrations/types/jira-auth-details';
import { ColumnsConfigKey } from '@/core/domain/integrationConfigs/types/projectManagement/columns.type';
import { ModuleWorkItemType } from '@/core/domain/integrationConfigs/types/projectManagement/moduleWorkItemTypes.type';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';
import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import * as console from 'node:console';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class AutomationIssuesDetailsService implements IAutomationFactory {
    automationType = AutomationType.AUTOMATION_ISSUES_DETAILS;

    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        private readonly communication: CommunicationService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        private readonly projectManagementService: ProjectManagementService,
    ) {}

    async setup(payload): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            const teamAutomation = {
                status: true,
                automation: {
                    uuid: automation.uuid,
                },
                team: {
                    uuid: payload.teamId,
                },
            };

            await this.teamAutomationService.register(teamAutomation);
        } catch (error) {
            console.log('Error while creating automation for the team', error);
        }
    }

    async stop(payload: { teamId: string }): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            return await this.teamAutomationService.update(
                {
                    team: { uuid: payload.teamId },
                    automation: { uuid: automation.uuid },
                },
                {
                    status: false,
                },
            );
        } catch (error) {
            console.log(
                'Error while deactivating automation for the team',
                error,
            );
        }
    }

    async run(payload?: {
        organizationAndTeamData: OrganizationAndTeamData;
        teamAutomationId: string;
        origin: string;
    }): Promise<any> {
        try {
            const VALIDATION_SCORE = 25;

            const authIntegration =
                await this.integrationService.getPlatformAuthDetails<JiraAuthDetail>(
                    payload.organizationAndTeamData,
                    PlatformType.JIRA,
                );

            const integrationConfigColumnsMapping =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    payload.organizationAndTeamData,
                );

            if (!integrationConfigColumnsMapping) {
                return;
            }

            const workItemTypes = (
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ModuleWorkItemType[]
                >(
                    IntegrationConfigKey.MODULE_WORKITEMS_TYPES,
                    payload.organizationAndTeamData,
                )
            )?.find(
                (workItemType) =>
                    workItemType.name ===
                    MODULE_WORKITEMS_TYPES.IMPROVE_TASK_DESCRIPTION,
            ).workItemTypes;

            const columnsConfigKey =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    ColumnsConfigKey[]
                >(
                    IntegrationConfigKey.COLUMNS_MAPPING,
                    payload.organizationAndTeamData,
                );

            const todoColumns = columnsConfigKey
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'todo',
                )
                .map((columnConfig: ColumnsConfigKey) => columnConfig.id);

            const WIPColumns = columnsConfigKey
                .filter(
                    (columnConfig: ColumnsConfigKey) =>
                        columnConfig.column === 'wip',
                )
                .map((columnConfig: ColumnsConfigKey) => columnConfig.id);

            const workItems: any[] =
                await this.projectManagementService.getAllWorkItemsInWIP({
                    organizationAndTeamData: payload.organizationAndTeamData,
                    filters: {
                        workItemTypes,
                        statusesIds: todoColumns.concat(WIPColumns),
                        expandChangelog: true,
                        showDescription: true,
                    },
                });
            if (workItems?.length === 0) {
                return;
            }

            const workItemsData = [];

            for (const workItem of workItems) {
                const movementsEntry = workItem.changelog.find(
                    (entry: { movements: any[] }) =>
                        entry.movements.some(
                            (item) =>
                                item.field === 'status' &&
                                todoColumns.some(
                                    (done) => done === item.toColumnId,
                                ),
                        ),
                );

                if (!movementsEntry?.createdAt) {
                    continue;
                }

                const movementsDate = new Date(movementsEntry?.createdAt);

                if (!movementsDate) {
                    continue;
                }

                const aging = moment().diff(moment(movementsDate), 'days');
                if (aging < 1) {
                    continue;
                }

                const previousRunAutomation =
                    await this.automationExecutionService.findOneByOrganizationIdAndIssueId(
                        payload.organizationAndTeamData.organizationId,
                        workItem?.id,
                    );

                if (previousRunAutomation) {
                    continue;
                }
            }

            if (workItemsData.length === 0) {
                return;
            }

            workItemsData.splice(5);

            const automation: IAutomation =
                await this.automationService.findOne({
                    automationType: this.automationType,
                });

            const teamAutomation = (
                await this.teamAutomationService.find({
                    automation: { uuid: automation?.uuid },
                    team: {
                        uuid: payload?.organizationAndTeamData.teamId,
                    },
                })
            )[0];

            if (!teamAutomation) {
                return;
            }

            const channelId = await this.communication.getTeamChannelId(
                payload.organizationAndTeamData,
            );

            await this.newMessage(
                {
                    communicationId: channelId,
                },
                {
                    organizationAndTeamData: {
                        organizationId:
                            payload?.organizationAndTeamData.organizationId,
                        teamId: payload?.organizationAndTeamData.teamId,
                    },
                },
                [...workItemsData],
            );

            await this.createAutomationExecution(
                {
                    channelIds: channelId,
                    organizationId:
                        payload.organizationAndTeamData.organizationId,
                },
                payload.teamAutomationId,
                payload.origin,
            );
        } catch (error) {
            console.log('error while executing automation', error);
        }
    }

    async newMessage(member, payload, issue) {
        const template = await this.communication.handlerTemplateMessage({
            methodName: 'getMessageAutomationIssuesDetails',
            issue: issue,
            member: member,
            payload: payload,
            organizationAndTeamData: payload.organizationAndTeamData,
        });

        await this.communication.newBlockMessage({
            organizationAndTeamData: payload.organizationAndTeamData,
            blocks: template,
            channelId: member.communicationId,
        });
    }

    private async createAutomationExecution(
        data: any,
        teamAutomationId: string,
        origin: string,
    ) {
        const automationExecution = {
            status: AutomationStatus.SUCCESS,
            dataExecution: data,
            teamAutomation: { uuid: teamAutomationId },
            origin,
        };

        this.automationExecutionService.register(automationExecution);
    }
}
