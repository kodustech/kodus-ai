import { createLogger } from '@libs/core/log/logger';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { KodyFineTuningService } from '@libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { Injectable } from '@nestjs/common';

@Injectable()
export class KodyFineTuningStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'KodyFineTuningStage';
    private readonly logger = createLogger(KodyFineTuningStage.name);

    constructor(private readonly kodyFineTuningService: KodyFineTuningService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.codeReviewConfig.kodyFineTuningConfig?.enabled) {
            this.logger.log({
                message: StageMessageHelper.skippedWithReason(
                    PipelineReasons.FINE_TUNING.DISABLED,
                ),
                context: KodyFineTuningStage.name,
            });
            return context;
        }

        const clusterizedSuggestions =
            await this.kodyFineTuningService.startAnalysis(
                context.organizationAndTeamData.organizationId,
                {
                    id: context.repository.id,
                    full_name: context.repository.fullName,
                },
                context.pullRequest.number,
                context.repository.language,
            );

        if (!clusterizedSuggestions?.length) {
            this.logger.log({
                message: StageMessageHelper.skippedWithReason(
                    PipelineReasons.FINE_TUNING.NO_MATCHES,
                ),
                context: KodyFineTuningStage.name,
            });
            return context;
        }

        return this.updateContext(context, (draft) => {
            draft.clusterizedSuggestions = clusterizedSuggestions;
        });
    }
}
