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
const MIN_SUBSTANTIAL_FRAGMENT_LENGTH = 10;
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
    if (value === contextBody) {
        return true;
    }

    const trimmedValue = value.trim();
    const trimmedContext = contextBody.trim();
    if (trimmedValue.length > 0 && trimmedValue === trimmedContext) {
        return true;
    }

    const normalizedContext = normalizeContextText(contextBody);
    const normalizedValue = normalizeContextText(value);
    if (normalizedValue.length === 0 || normalizedContext.length === 0) {
        return false;
    }
    if (normalizedValue === normalizedContext) {
        return true;
    }
    if (normalizedContext.length < MIN_SUBSTANTIAL_FRAGMENT_LENGTH) {
        return false;
    }

    if (
        normalizedValue.includes(normalizedContext) ||
        (normalizedContext.includes(normalizedValue) &&
            normalizedValue.length >= MIN_SUBSTANTIAL_FRAGMENT_LENGTH)
    ) {
        return true;
    }

    const contextLines = contextBody
        .split(/\r?\n/u)
        .map(normalizeContextText)
        .filter((line) => line.length >= MIN_SUBSTANTIAL_FRAGMENT_LENGTH);
    if (contextLines.some((line) => normalizedValue.includes(line))) {
        return true;
    }

    return hasSharedTokenSequence(tokens(value), tokens(contextBody));
}

function redactModelText(value: string, contextBody: string): string {
    return isContextEcho(value, contextBody) ? REVIEW_CONTEXT_REDACTION : value;
}

/**
 * Removes exact or substantial packet echoes before a response reaches durable
 * job state or the caller. A substantial echo is a normalized standalone
 * packet fragment of at least ten characters, a packet line of that size, or a
 * shared run of four to eight tokens. Short overlaps remain valid review output
 * because their provenance cannot be distinguished from identifiers in code.
 *
 * @param response - Server-formatted CLI review response.
 * @param contextBody - Request-scoped packet body, when one was supplied.
 * @returns A response with qualifying echoes replaced in model-controlled fields.
 */
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
            file: redactModelText(issue.file, contextBody),
            message: redactModelText(issue.message, contextBody),
            ...(issue.category !== undefined
                ? {
                      category: redactModelText(issue.category, contextBody),
                  }
                : {}),
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
            ...(issue.ruleId !== undefined
                ? { ruleId: redactModelText(issue.ruleId, contextBody) }
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
