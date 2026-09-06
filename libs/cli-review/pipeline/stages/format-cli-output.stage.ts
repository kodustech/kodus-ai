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

const REVIEW_CONTEXT_REDACTION = '[review context redacted]';
const MIN_CONTEXT_SIGNAL_LENGTH = 12;
const MIN_CONTEXT_LINE_LENGTH = 16;
const MIN_TOKEN_SEQUENCE = 4;

function normalizeContextText(value: string): string {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function tokens(value: string): readonly string[] {
    const normalized = normalizeContextText(value);
    return normalized.length === 0 ? [] : normalized.split(' ');
}

function hasSharedTokenSequence(
    valueTokens: readonly string[],
    contextTokens: readonly string[],
): boolean {
    if (
        valueTokens.length < MIN_TOKEN_SEQUENCE ||
        contextTokens.length < MIN_TOKEN_SEQUENCE
    ) {
        return false;
    }

    const required = Math.max(
        MIN_TOKEN_SEQUENCE,
        Math.min(8, Math.ceil(valueTokens.length * 0.5)),
    );
    if (required > contextTokens.length || required > valueTokens.length) {
        return false;
    }

    const contextSequences = new Set<string>();
    for (let index = 0; index <= contextTokens.length - required; index += 1) {
        contextSequences.add(
            contextTokens.slice(index, index + required).join(' '),
        );
    }

    for (let index = 0; index <= valueTokens.length - required; index += 1) {
        if (
            contextSequences.has(
                valueTokens.slice(index, index + required).join(' '),
            )
        ) {
            return true;
        }
    }

    return false;
}

function isContextEcho(value: string, contextBody: string): boolean {
    const normalizedContext = normalizeContextText(contextBody);
    const normalizedValue = normalizeContextText(value);
    if (normalizedValue.length === 0) {
        return false;
    }
    if (normalizedValue === normalizedContext) {
        return true;
    }
    if (normalizedContext.length < MIN_CONTEXT_SIGNAL_LENGTH) {
        return false;
    }

    if (
        normalizedValue.includes(normalizedContext) ||
        (normalizedContext.includes(normalizedValue) &&
            normalizedValue.length >= MIN_CONTEXT_LINE_LENGTH)
    ) {
        return true;
    }

    const contextLines = contextBody
        .split(/\r?\n/u)
        .map(normalizeContextText)
        .filter((line) => line.length >= MIN_CONTEXT_LINE_LENGTH);
    if (contextLines.some((line) => normalizedValue.includes(line))) {
        return true;
    }

    return hasSharedTokenSequence(tokens(value), tokens(contextBody));
}

function redactModelText(value: string, contextBody: string): string {
    return isContextEcho(value, contextBody) ? REVIEW_CONTEXT_REDACTION : value;
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
        issues: response.issues.map((issue) => ({
            ...issue,
            message: redactModelText(issue.message, contextBody),
            ...(issue.suggestion !== undefined
                ? {
                      suggestion: redactModelText(
                          issue.suggestion,
                          contextBody,
                      ),
                  }
                : {}),
            ...(issue.recommendation !== undefined
                ? {
                      recommendation: redactModelText(
                          issue.recommendation,
                          contextBody,
                      ),
                  }
                : {}),
            ...(issue.fix
                ? {
                      fix: {
                          ...issue.fix,
                          replacement: redactModelText(
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
