import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';
import { CliInputConverter } from '@libs/cli-review/infrastructure/converters/cli-input.converter';
import { createLogger } from '@libs/core/log/logger';

/**
 * Pipeline stage to format analysis results into CLI response format
 * Uses CliInputConverter to transform suggestions into CLI issues
 */
@Injectable()
export class FormatCliOutputStage extends BasePipelineStage<CliReviewPipelineContext> {
    readonly stageName = 'FormatCliOutputStage';
    private readonly logger = createLogger(FormatCliOutputStage.name);

    constructor(private readonly converter: CliInputConverter) {
        super();
    }

    protected async executeStage(
        context: CliReviewPipelineContext,
    ): Promise<CliReviewPipelineContext> {
        this.logger.log({
            message: `Formatting ${context.validSuggestions.length} suggestions for CLI output`,
            context: this.stageName,
            metadata: {
                correlationId: context.correlationId,
                suggestionsCount: context.validSuggestions.length,
                filesAnalyzed: context.changedFiles.length,
            },
        });

        // Convert pipeline results to CLI format
        const cliResponse = this.converter.convertToCliResponse(
            context.validSuggestions,
            context.changedFiles.length,
            context.startTime,
        );

        this.logger.log({
            message: 'CLI response formatted successfully',
            context: this.stageName,
            metadata: {
                correlationId: context.correlationId,
                issuesCount: cliResponse.issues.length,
                summary: cliResponse.summary,
                duration: cliResponse.duration,
            },
        });

        return this.updateContext(context, (draft) => {
            draft.cliResponse = cliResponse;
        });
    }
}
