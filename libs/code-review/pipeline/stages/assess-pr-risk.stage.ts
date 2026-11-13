import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PrRiskAssessmentService } from '../services/pr-risk-assessment.service';
import { RISK_ASSESSMENT_FAILED_REASON } from '../constants/error-reasons';

@Injectable()
export class AssessPrRiskStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'AssessPrRiskStage';
    readonly label = 'Assessing PR risk';
    readonly visibility = StageVisibility.SECONDARY;
    readonly errorSeverity = 'partial' as const;

    constructor(private readonly risk: PrRiskAssessmentService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const result = await this.risk.assess(context);
        const assessment = result.assessment;
        return this.updateContext(context, (draft) => {
            draft.riskAssessment = assessment;
            draft.fullPrFiles = result.fullPrFiles;
            // A failed judgment stays `unavailable` (never safe), but the stage
            // and the review must not read as a clean success (#2385). Expected
            // outcomes such as a push during the diff read carry no failure.
            if (assessment.status === 'unavailable' && assessment.failure) {
                draft.errors ??= [];
                draft.errors.push({
                    stage: this.stageName,
                    severity: 'partial',
                    error: new Error(assessment.reason),
                    metadata: {
                        reason: RISK_ASSESSMENT_FAILED_REASON,
                        ...assessment.failure,
                    },
                });
            }
        });
    }
}
