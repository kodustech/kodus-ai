import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '../logger/pino.service';
import { FlowMetricsCheckinSection } from './sections/teamFlowMetrics.section';
import { ICheckinService } from '@/core/domain/checkins/contracts/checkin.service.contract';
import { DoraMetricsCheckinSection } from './sections/teamDoraMetrics.section';
import { TeamArtifactsSection } from './sections/teamArtifacts.section';
import { ReleaseNotesSection } from './sections/releaseNotes.section';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { STRING_TIME_INTERVAL } from '@/core/domain/integrationConfigs/enums/stringTimeInterval.enum';
import { LateWorkItemsSection } from './sections/lateWorkItems.section';
import { PullRequestsOpenedSection } from './sections/pullRequestsOpen.section';
import {
    CheckinConfigValue,
    SectionType,
} from '@/core/domain/parameters/types/configValue.type';
import { PromptService } from '../prompt.service';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { INTEGRATION_SERVICE_TOKEN } from '@/core/domain/integrations/contracts/integration.service.contracts';
import { IIntegrationService } from '@/core/domain/integrations/contracts/integration.service.contracts';
import { CommunicationService } from '../platformIntegration/communication.service';
import { ButtonsSection } from './sections/buttons.section';
import { SlackFormatter, SlackSection } from './fomatters/slack.formatter';
import {
    ISnoozedItemsService,
    SNOOZED_ITEMS_SERVICE_TOKEN,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';
import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { SectionType as SectionTypeEnum } from '@/core/domain/snoozedItems/enums/section-type.enum';
import { ITeam } from '@/core/domain/team/interfaces/team.interface';
import { ValidateCommunicationManagementIntegration } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';

@Injectable()
export class CheckinService implements ICheckinService {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        private readonly logger: PinoLoggerService,

        private readonly promptService: PromptService,

        private readonly communicationService: CommunicationService,

        private readonly teamFlowMetricsSection: FlowMetricsCheckinSection,

        private readonly teamDoraMetricsSection: DoraMetricsCheckinSection,

        private readonly teamArtifactsSection: TeamArtifactsSection,

        private readonly releaseNotesSection: ReleaseNotesSection,

        private readonly lateWorkItemsSection: LateWorkItemsSection,

        private readonly pullRequestsOpened: PullRequestsOpenedSection,

        private readonly buttonsSection: ButtonsSection,
    ) {}

    @ValidateCommunicationManagementIntegration()
    async generate(payload?: {
        organizationAndTeamData: OrganizationAndTeamData;
        checkinConfig: CheckinConfigValue;
        team: Partial<ITeam>;
    }): Promise<any> {
        try {
            const sections: Array<any> = [];
            let checkinContent: any;
            let checkinDataSent: Record<string, unknown> = {};
            let checkinNotification: any;

            const platform = await this.communicationService.getTypeIntegration(
                payload.organizationAndTeamData,
            );

            const snoozedItems = await this.snoozedItemsService.getByCategory({
                teamId: payload.organizationAndTeamData.teamId,
                organizationId: payload.organizationAndTeamData.organizationId,
                category: ModuleCategory.CHECKIN,
            });

            const frequency =
                payload.checkinConfig.checkinId === 'weekly-checkin'
                    ? 'weekly'
                    : 'daily';

            const sectionExecutors: {
                [key in SectionType]: () => Promise<any>;
            } = {
                releaseNotes: () =>
                    this.releaseNotesSection.execute(
                        payload.organizationAndTeamData,
                        STRING_TIME_INTERVAL.LAST_7_DAYS,
                    ),
                pullRequestsOpened: () =>
                    this.pullRequestsOpened.execute(
                        payload.organizationAndTeamData,
                        frequency,
                    ),
                lateWorkItems: () =>
                    this.lateWorkItemsSection.execute(
                        payload.organizationAndTeamData,
                        frequency,
                        snoozedItems?.length > 0
                            ? snoozedItems.filter(
                                  (x) =>
                                      x.toObject().sectionType ===
                                      SectionTypeEnum.LATE_WORK_ITEMS,
                              )
                            : [],
                    ),
                teamArtifacts: () =>
                    this.teamArtifactsSection.execute(
                        payload.organizationAndTeamData,
                        frequency,
                        snoozedItems?.length > 0
                            ? snoozedItems.filter(
                                  (x) =>
                                      x.toObject().sectionType ===
                                      SectionTypeEnum.TEAM_ARTIFACTS,
                              )
                            : [],
                    ),
                teamDoraMetrics: () =>
                    this.teamDoraMetricsSection.execute(
                        payload.organizationAndTeamData,
                    ),
                teamFlowMetrics: () =>
                    this.teamFlowMetricsSection.execute(
                        payload.organizationAndTeamData,
                    ),
            };

            const orderedSections = Object.entries(
                payload.checkinConfig.sections,
            )
                .filter(([, sectionConfig]) => sectionConfig.active)
                .sort((a, b) => a[1].order - b[1].order);

            for (const [, sectionConfig] of orderedSections) {
                const sectionType = sectionConfig.id as SectionType;
                if (sectionExecutors[sectionType]) {
                    const sectionResult = await sectionExecutors[sectionType]();
                    if (sectionResult !== undefined) {
                        sections.push(sectionResult);
                    }
                } else {
                    this.logger.warn({
                        message: `Seção não encontrada: ${sectionType}`,
                        context: CheckinService.name,
                    });
                }
            }

            if (sections.some((section) => section?.sectionData?.length > 0)) {
                checkinContent = await this.generateCheckinContentWithData(
                    payload,
                    sections,
                    platform,
                );

                checkinDataSent = this.saveCheckinDataItems(sections);

                // TODO: Move this to the mapper to make it correct
                if (platform === PlatformType.SLACK) {
                    const formatSlack = new SlackFormatter();
                    checkinNotification = formatSlack.transform(
                        checkinContent,
                        payload?.team.name,
                        frequency,
                    );
                } else {
                    checkinNotification = checkinContent;
                }
            } else {
                checkinNotification =
                    await this.generateCheckinContentWithoutData(
                        platform,
                        payload?.team?.name,
                        frequency,
                    );
            }

            return {
                notification: checkinNotification,
                sectionDataItems: checkinDataSent,
            };
        } catch (error) {
            this.logger.error({
                message: `Error while creating check-in`,
                context: CheckinService.name,
                error: error,
            });
            throw error;
        }
    }

    getSectionsInfo(): {
        name: string;
        id: string;
        description: string;
        additionalConfigs: any[];
        order: number;
    }[] {
        return [
            {
                name: this.releaseNotesSection.name(),
                id: this.releaseNotesSection.id(),
                description: this.releaseNotesSection.description(),
                additionalConfigs: [],
                order: 1,
            },
            {
                name: this.teamArtifactsSection.name(),
                id: this.teamArtifactsSection.id(),
                description: this.teamArtifactsSection.description(),
                additionalConfigs:
                    this.teamArtifactsSection.additionalConfigs(),
                order: 2,
            },
            {
                name: this.teamFlowMetricsSection.name(),
                id: this.teamFlowMetricsSection.id(),
                description: this.teamFlowMetricsSection.description(),
                additionalConfigs: [],
                order: 3,
            },
            {
                name: this.lateWorkItemsSection.name(),
                id: this.lateWorkItemsSection.id(),
                description: this.lateWorkItemsSection.description(),
                additionalConfigs: [],
                order: 4,
            },
            {
                name: this.pullRequestsOpened.name(),
                id: this.pullRequestsOpened.id(),
                description: this.pullRequestsOpened.description(),
                additionalConfigs: [],
                order: 5,
            },
            {
                name: this.teamDoraMetricsSection.name(),
                id: this.teamDoraMetricsSection.id(),
                description: this.teamDoraMetricsSection.description(),
                additionalConfigs: [],
                order: 6,
            },
        ];
    }

    private async generateNotification(
        organizationAndTeamData: OrganizationAndTeamData,
        sections: any[],
        teamName: string,
        checkinName: string,
    ): Promise<any> {
        try {
            const llm = await getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_ALL,
                ),
            }).bind({
                response_format: { type: 'json_object' },
            });

            const integrations =
                await this.integrationService.getPlatformIntegration(
                    organizationAndTeamData,
                );

            const payload = {
                inputMessage: {
                    sections,
                    teamName,
                    checkinName,
                    teamId: organizationAndTeamData?.teamId,
                },
            };

            const promptName = this.getPromptNameForIntegration(
                integrations.communication,
            );

            const promptCheckin =
                await this.promptService.getCompleteContextPromptByName(
                    promptName,
                    {
                        organizationAndTeamData,
                        payload: payload,
                        promptIsForChat: false,
                    },
                );

            const checkinNotification = safelyParseMessageContent(
                (
                    await llm.invoke(promptCheckin, {
                        metadata: {
                            submodule: 'GetWarnings',
                            module: 'AutomationDailyCheckin',
                            teamId: organizationAndTeamData.teamId,
                        },
                    })
                ).content,
            );

            return checkinNotification;
        } catch (error) {
            console.error(error);
            throw new Error(
                'Error trying to format check-in notification for the team: ',
                error,
            );
        }
    }

    // TODO: Move this to the mapper to make it correct
    private getPromptNameForIntegration(integration: string) {
        switch (integration.toUpperCase()) {
            case PlatformType.DISCORD:
                return 'prompt_discord_checkin_formatter';
            case PlatformType.SLACK:
                return 'prompt_slack_checkin_formatter';
            default:
                return 'prompt_slack_checkin_formatter';
        }
    }

    private saveCheckinDataItems(sections) {
        const result = {
            lateWorkItems: {
                sectionId: 'lateWorkItems',
                itemsSent: [],
            },
            pullRequestsOpened: {
                sectionId: 'pullRequestsOpened',
                itemsSent: [],
            },
            teamArtifacts: {
                sectionId: 'teamArtifacts',
                itemsSent: [],
            },
        };

        sections.forEach((section) => {
            switch (section.sectionId) {
                case 'lateWorkItems':
                    result.lateWorkItems.itemsSent = section.sectionData.map(
                        (item) => ({
                            key: item.key,
                        }),
                    );
                    break;
                case 'pullRequestsOpened':
                    result.pullRequestsOpened.itemsSent =
                        section.sectionData.map((item) => ({
                            id: item.id.toString(),
                        }));
                    break;
                case 'teamArtifacts':
                    result.teamArtifacts.itemsSent = section.sectionData.map(
                        (item) => ({
                            name: item.name,
                        }),
                    );
                    break;
            }
        });

        return result;
    }

    private async generateCheckinContentWithData(
        payload: any,
        sections,
        platform: PlatformType,
    ) {
        const buttonsSectionResult = await this.buttonsSection.execute(
            payload.organizationAndTeamData,
            sections,
            payload.team.uuid,
        );

        sections.push(buttonsSectionResult);

        return await this.generateNotification(
            payload.organizationAndTeamData,
            sections,
            payload.checkinConfig.checkinName,
            payload.team.name,
        );
    }

    private generateCheckinContentWithoutData(
        platform: PlatformType,
        teamName?: string,
        frequency?: string,
    ) {
        const message = 'All good here! No alerts to show.';

        if (platform === PlatformType.DISCORD) {
            return {
                embeds: [
                    {
                        title: 'Daily Check-in - Kody Copilot',
                        description: message,
                    },
                ],
            };
        } else if (platform === PlatformType.SLACK) {
            const emptyAlertSection: SlackSection = {
                sectionId: 'Empty Alert',
                sectionTitle: '',
                sectionContent: [
                    {
                        text: message,
                        sectionKey: 'emptyAlert',
                    },
                ],
                possibleToMutate: false,
            };
            const formatSlack = new SlackFormatter();
            return formatSlack.transform(
                { sections: [emptyAlertSection] },
                teamName,
                frequency,
            );
        } else {
            return {
                message,
            };
        }
    }
}
