import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ValidateConfigStage } from './validate-config.stage';
import {
    customAgentCandidates,
    customAgentRiskSkipReason,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';

@Injectable()
export class ResolveRiskRoutingStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'ResolveRiskRoutingStage';
    readonly silent = true;

    constructor(private readonly configuration: ValidateConfigStage) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const routed =
            context.codeReviewConfig?.riskAssessmentActive === true
                ? await this.configuration.resolveReviewRouting(context)
                : context;
        const skips = customAgentCandidates(
            routed.codeReviewConfig?.customAgents,
            routed.onlyCustomAgent,
        ).flatMap((agent) => {
            const reason = customAgentRiskSkipReason(
                agent,
                routed.riskAssessment,
                routed.onlyCustomAgent,
            );
            return reason ? [{ id: agent.id, reason }] : [];
        });
        return this.updateContext(routed, (draft) => {
            draft.customAgentRiskSkips = skips;
        });
    }
}
