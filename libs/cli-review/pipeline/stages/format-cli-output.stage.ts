import { Injectable } from '@nestjs/common';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';
import type { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';
import type { ReviewContextDelivery } from '@libs/cli-review/domain/types/review-context.types';
import { CliInputConverter } from '@libs/cli-review/infrastructure/converters/cli-input.converter';
import { createLogger } from '@libs/core/log/logger';

export function withReviewContextDeliveries(
    response: CliReviewResponse,
    deliveries: readonly ReviewContextDelivery[] | undefined,
): CliReviewResponse {
    if (!deliveries?.length) {
        return response;
    }

    return {
        ...response,
        reviewContextDeliveries: deliveries,
    };
}

function redactContextText(value: string, contextBody: string): string {
    return value.replaceAll(contextBody, '[review context redacted]');
}

export function redactReviewContextFromResponse(
    response: CliReviewResponse,
    contextBody: string | undefined,
): CliReviewResponse {
    if (!contextBody) {
        return response;
    }

    return {
        ...response,
        summary: redactContextText(response.summary, contextBody),
        issues: response.issues.map((issue) => ({
            ...issue,
            file: redactContextText(issue.file, contextBody),
            severity: redactContextText(issue.severity, contextBody),
            message: redactContextText(issue.message, contextBody),
            ...(issue.category !== undefined
                ? {
                      category: redactContextText(issue.category, contextBody),
                  }
                : {}),
            ...(issue.suggestion !== undefined
                ? {
                      suggestion: redactContextText(
                          issue.suggestion,
                          contextBody,
                      ),
                  }
                : {}),
            ...(issue.recommendation !== undefined
                ? {
                      recommendation: redactContextText(
                          issue.recommendation,
                          contextBody,
                      ),
                  }
                : {}),
            ...(issue.ruleId !== undefined
                ? { ruleId: redactContextText(issue.ruleId, contextBody) }
                : {}),
            ...(issue.fix
                ? {
                      fix: {
                          ...issue.fix,
                          replacement: redactContextText(
                              issue.fix.replacement,
                              contextBody,
                          ),
                      },
                  }
                : {}),
        })),
    };
}

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
        const baseResponse = this.converter.convertToCliResponse(
            context.validSuggestions,
            context.changedFiles.length,
            context.startTime,
        );
        const redactedResponse = redactReviewContextFromResponse(
            baseResponse,
            context.reviewContext?.body,
        );
        const cliResponse = withReviewContextDeliveries(
            redactedResponse,
            context.reviewContextDeliveries,
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
