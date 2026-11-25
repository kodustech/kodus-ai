import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';

/**
 * Checks a medium risk rating in the repository once the review's sandbox
 * exists, before the review agents run and the sandbox is released. Its
 * result only reaches the approval decision: routing and risk-conditioned
 * agents already ran on the first judgment. Never fails the review.
 */
@Injectable()
export class RiskSecondLookStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RiskSecondLookStage';
    readonly label = 'Checking risk in the repository';
    readonly visibility = StageVisibility.SECONDARY;

    constructor(private readonly risk: PrRiskAssessmentService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const risk = context.riskAssessment;
        const remoteCommands = context.sandboxHandle?.remoteCommands;
        if (
            !context.codeReviewConfig?.pullRequestApprovalActive ||
            context.codeReviewConfig.riskAssessmentActive !== true ||
            context.origin === 'cli' ||
            context.sandboxHandle?.type === 'null' ||
            !remoteCommands ||
            !context.fullPrFiles?.length ||
            risk?.status !== 'assessed' ||
            !risk.riskIdentified ||
            context.riskLevel !== 'medium'
        )
            return context;
        const look = await this.risk.secondLook({
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            pullRequest: context.pullRequest,
            language: context.codeReviewConfig.languageResultPrompt,
            risk,
            level: context.riskLevel,
            files: context.fullPrFiles,
            remoteCommands,
        });
        return look
            ? this.updateContext(context, (draft) => {
                  draft.riskSecondLook = look;
              })
            : context;
    }
}
