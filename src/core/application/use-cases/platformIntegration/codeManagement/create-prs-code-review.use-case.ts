import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { AutomationExecutionService } from '@/core/infrastructure/adapters/services/automation/automation-execution.service';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/automation-execution.service';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { ITeamAutomationService, TEAM_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/team-automation.service';

@Injectable()
export class CreatePRCodeReviewUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: AutomationExecutionService,


        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) { }

    public async execute(params: {
        teamId: string;
        payload: any
    }) {
        try {
            const { teamId, payload } = params;
            const organizationId = this.request.user.organization.uuid;

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId,
            }

            const data = {
                organizationAndTeamData,
                repository: {
                    id: payload.id,
                    name: payload.repository,
                },
                prNumber: payload?.pull_number,
                body: "@kody start-review"
            }

            const response = await this.codeManagementService.createSingleIssueComment(data);

            const teamAutomation = await this.teamAutomationService.find({
                team: { uuid: teamId },
            });

            const codeReviewAutomation = teamAutomation.find((automation) => {
                return automation.automation.automationType = AutomationType.AUTOMATION_CODE_REVIEW
            });

            if (!response) {
                await this.registerFailedAutomationExecution(codeReviewAutomation?.uuid);

                throw new HttpException(`Error when commenting on PR ${payload.pull_number}`, HttpStatus.INTERNAL_SERVER_ERROR);
            }

            await this.registerSuccessfulAutomationExecution(codeReviewAutomation?.uuid, payload);

            return { success: true }
        }
        catch (err) {
            throw err;
        }
    }

    private async registerFailedAutomationExecution(codeReviewAutomationId: string) {
        const startedCodeReview = {
            status: AutomationStatus.ERROR,
            dataExecution: {},
            teamAutomation: { uuid: codeReviewAutomationId },
            origin: ""
        }

        await this.automationExecutionService.register(startedCodeReview)
    }

    private async registerSuccessfulAutomationExecution(codeReviewAutomationId: string, payload: any) {
        const startedCodeReview = {
            status: AutomationStatus.SUCCESS,
            dataExecution: {
                onboardingFinishReview: false,
                ...payload,
            },
            teamAutomation: { uuid: codeReviewAutomationId },
            origin: ""
        }

        await this.automationExecutionService.register(startedCodeReview)
    }

}
