import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';

@Injectable()
export class AssessPrRiskStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'AssessPrRiskStage';
    readonly label = 'Assessing PR risk';
    readonly visibility = StageVisibility.SECONDARY;

    constructor(private readonly risk: PrRiskAssessmentService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const result = await this.risk.assess(context);
        return this.updateContext(context, (draft) => {
            draft.riskAssessment = result.assessment;
            draft.fullPrFiles = result.fullPrFiles;
        });
    }
}
