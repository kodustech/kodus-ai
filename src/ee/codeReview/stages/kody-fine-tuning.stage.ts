import { Injectable } from '@nestjs/common';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { BasePipelineStage } from '@/core/infrastructure/adapters/services/pipeline/base-stage.abstract';
import { CodeReviewPipelineContext } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';

@Injectable()
export class KodyFineTuningStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'KodyFineTuningStage';

    constructor(private readonly kodyFineTuningService: KodyFineTuningService) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.codeReviewConfig.kodyFineTuningConfig?.enabled) {
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

        return this.updateContext(context, (draft) => {
            draft.clusterizedSuggestions = clusterizedSuggestions;
        });
    }
}
