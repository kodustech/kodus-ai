import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import {
    AUTOMATION_SERVICE_TOKEN,
    IAutomationService,
} from '@/core/domain/automation/contracts/automation.service';
import { IAutomationFactory } from '@/core/domain/automation/contracts/processAutomation/automation.factory';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { Inject, Injectable } from '@nestjs/common';
import { IAutomation } from '@/core/domain/automation/interfaces/automation.interface';
import { ITeamAutomation } from '@/core/domain/automation/interfaces/team-automation.interface';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { PinoLoggerService } from '../../../logger/pino.service';
import { CodeReviewHandlerService } from '../../../codeBase/codeReviewHandlerService.service';
import { IAutomationExecution } from '@/core/domain/automation/interfaces/automation-execution.interface';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';

@Injectable()
export class AutomationCodeReviewService
    implements Omit<IAutomationFactory, 'stop'>
{
    automationType = AutomationType.AUTOMATION_CODE_REVIEW;

    constructor(
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        private readonly codeReviewHandlerService: CodeReviewHandlerService,

        private readonly logger: PinoLoggerService,
    ) {}

    async setup(payload?: any): Promise<any> {
        try {
            // Fetch automation ID
            const automation: IAutomation = (
                await this.automationService.find({
                    automationType: this.automationType,
                })
            )[0];

            const teamAutomation: ITeamAutomation = {
                status: false,
                automation: {
                    uuid: automation.uuid,
                },
                team: {
                    uuid: payload.teamId,
                },
            };

            await this.teamAutomationService.register(teamAutomation);
        } catch (error) {
            this.logger.error({
                message: 'Error creating automation for the team',
                context: AutomationCodeReviewService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    async run?(payload?: any): Promise<any> {
        try {
            const {
                organizationAndTeamData,
                codeManagementEvent,
                branch,
                pullRequest,
                repository,
                teamAutomationId,
                platformType,
                origin,
                action,
            } = payload;

            this.logger.log({
                message: `Started Handling pull request for ${repository?.name} - ${branch} - PR#${pullRequest?.number}`,
                context: AutomationCodeReviewService.name,
                metadata: {
                    organizationAndTeamData,
                },
            });

            const organization = await this.organizationService.findOne({
                uuid: organizationAndTeamData.organizationId,
                status: true,
            });

            const result =
                await this.codeReviewHandlerService.handlePullRequest(
                    {
                        ...organizationAndTeamData,
                        organizationName: organization.name,
                    },
                    repository,
                    branch,
                    pullRequest,
                    platformType,
                    teamAutomationId,
                    origin || 'automation',
                    action,
                );

            if (result) {
                const validLastAnalyzedCommit =
                    result.lastAnalyzedCommit &&
                    typeof result.lastAnalyzedCommit === 'object' &&
                    Object.keys(result.lastAnalyzedCommit).length > 0;

                if (
                    validLastAnalyzedCommit &&
                    (result.commentId ||
                        result.noteId ||
                        result.threadId ||
                        result.overallComments)
                ) {
                    this.createAutomationExecution(
                        {
                            codeManagementEvent,
                            platformType,
                            organizationAndTeamData: organizationAndTeamData,
                            pullRequestNumber: pullRequest?.number,
                            overallComments: result.overallComments,
                            lastAnalyzedCommit: result.lastAnalyzedCommit,
                            commentId: result.commentId,
                            noteId: result.noteId,
                            threadId: result.threadId,
                        },
                        teamAutomationId,
                        'System',
                    );
                }

                await this.updateStartedCodeReviewAutomationExecutionStatus({
                    pullRequestNumber: pullRequest?.number,
                    origin,
                    teamAutomationId,
                });

                this.logger.log({
                    message: `Finish Success Handling pull request for ${repository?.name} - ${branch} - PR#${pullRequest?.number}`,
                    context: AutomationCodeReviewService.name,
                    metadata: {
                        organizationAndTeamData,
                        ...result,
                    },
                });

                return 'Automation executed successfully';
            } else {
                await this.updateStartedCodeReviewAutomationExecutionStatus({
                    pullRequestNumber: pullRequest?.number,
                    origin,
                    teamAutomationId,
                });

                this.logger.log({
                    message: `Finish Error Handling pull request for ${repository?.name} - ${branch} - PR#${pullRequest?.number}`,
                    context: AutomationCodeReviewService.name,
                    metadata: { organizationAndTeamData },
                });

                return 'Error while trying to execute the automation';
            }
        } catch (error) {
            this.logger.error({
                message: 'Error executing code review automation for the team.',
                context: AutomationCodeReviewService.name,
                error: error,
                metadata: payload,
            });
        }
    }

    private createAutomationExecution(
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

    private async updateStartedCodeReviewAutomationExecutionStatus(payload: {
        pullRequestNumber: number;
        teamAutomationId: string;
        origin: string;
    }) {
        const { teamAutomationId, pullRequestNumber } = payload;

        const automationExecutions = await this.automationExecutionService.find(
            {
                teamAutomation: {
                    uuid: teamAutomationId,
                },
            },
        );

        let filteredAutomationExecution = automationExecutions?.find(
            (automation) =>
                automation?.dataExecution &&
                automation?.dataExecution.pull_number === pullRequestNumber &&
                automation?.dataExecution.hasOwnProperty(
                    'onboardingFinishReview',
                ),
        );

        if (!filteredAutomationExecution) {
            return false;
        }

        filteredAutomationExecution.dataExecution.onboardingFinishReview = true;

        const updatedFilteredAutomationExecution: Partial<IAutomationExecution> =
            {
                uuid: filteredAutomationExecution.uuid,
                dataExecution: filteredAutomationExecution?.dataExecution,
                errorMessage: filteredAutomationExecution?.errorMessage,
                origin: filteredAutomationExecution?.origin,
                status: filteredAutomationExecution?.status,
                createdAt: filteredAutomationExecution?.createdAt,
                teamAutomation: filteredAutomationExecution?.teamAutomation,
                updatedAt: filteredAutomationExecution?.updatedAt,
            };

        await this.automationExecutionService.update(
            {
                uuid: updatedFilteredAutomationExecution.uuid,
            },
            updatedFilteredAutomationExecution,
        );

        return true;
    }
}
