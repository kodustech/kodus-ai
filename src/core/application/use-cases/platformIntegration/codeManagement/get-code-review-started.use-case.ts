import { AUTOMATION_EXECUTION_SERVICE_TOKEN, IAutomationExecutionService } from '@/core/domain/automation/contracts/automation-execution.service';
import { ITeamAutomationService, TEAM_AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { HttpStatusCode } from 'axios';
import { Request } from 'express';

@Injectable()
export class GetCodeReviewStartedUseCase implements IUseCase {
    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(REQUEST)
        private readonly request: Request & { user },
    ) { }

    public async execute(params: {
        teamId: string;
    }) {
        try {
            const { teamId } = params;

            const teamAutomations = await this.teamAutomationService.find({
                team: {
                    uuid: teamId
                }
            });

            if (!teamAutomations) {
                throw new HttpException("No team automations were found", HttpStatusCode.InternalServerError);
            }

            const codeReviewAutomation = teamAutomations.find((automation) =>
                automation.automation.automationType === AutomationType.AUTOMATION_CODE_REVIEW,
            );

            if (!codeReviewAutomation) {
                throw new HttpException("Code review automation is not activated", HttpStatusCode.InternalServerError);
            }

            const automationExecutions = await this.automationExecutionService.find({
                teamAutomation: {
                    uuid: codeReviewAutomation.uuid,
                    team: {
                        uuid: teamId
                    }
                },

            });

            if (!automationExecutions) {
                return {};
            }
            const filteredAutomationExecution = automationExecutions.find((automation) => (
                (automation?.dataExecution) && (automation?.dataExecution?.hasOwnProperty("onboardingFinishReview"))
            ))

            const result = {
                onboardingFinishReview: filteredAutomationExecution?.dataExecution?.onboardingFinishReview,
                ...filteredAutomationExecution?.dataExecution
            }

            return result;
        }
        catch (err) {
            throw err;
        }
    }
}
