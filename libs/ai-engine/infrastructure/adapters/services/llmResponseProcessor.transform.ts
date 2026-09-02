import { createLogger } from '@libs/core/log/logger';
import { tryParseJSONObject } from '@libs/common/utils/transforms/json';
import {
    extractJsonFromText,
    normalizeEnvelope,
} from '@libs/llm/structured-output-repair';
import { LLM_ENVELOPE_TAG, LLM_ERROR_TAG } from '@libs/llm/log-tags';

import {
    AIAnalysisResult,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export class LLMResponseProcessor {
    private readonly logger = createLogger(LLMResponseProcessor.name);
    constructor() {}

    public processResponse(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: string,
    ): AIAnalysisResult | null {
        try {
            // The ONE text→JSON extractor: unwraps a ```json fence, drops prose
            // around the object, strips trailing commas — replaces the bespoke
            // inline markdown-strip this used to carry.
            const cleanResponse = extractJsonFromText(response) ?? response;

            // Attempt to parse the JSON — validator picks the first block
            // containing codeSuggestions when multiple code blocks exist
            let parsedResponse = tryParseJSONObject(cleanResponse, (obj) =>
                Array.isArray(obj?.codeSuggestions),
            );

            // SHAPE recovery (#1786): a non-strict model that wrapped
            // ({result:{codeSuggestions}}), renamed (suggestions/findings), or
            // bare-arrayed the payload fails the predicate above → returns null →
            // the caller drops it silently. Recover the canonical shape first.
            if (!parsedResponse) {
                const normalized = normalizeEnvelope(
                    response,
                    'codeSuggestions',
                    ['suggestions', 'findings'],
                );
                if (
                    normalized &&
                    typeof normalized === 'object' &&
                    Array.isArray((normalized as any).codeSuggestions)
                ) {
                    parsedResponse = normalized as any;
                }
            }

            if (!parsedResponse) {
                this.logger.error({
                    message: `${LLM_ERROR_TAG} ${LLM_ENVELOPE_TAG} Failed to parse LLM response (unrecoverable off-schema payload → dropped)`,
                    context: 'LLMResponseProcessor',
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                    },
                });
                return null;
            }

            // Normalize the types of fields that might come as strings
            if (parsedResponse?.codeSuggestions) {
                parsedResponse.codeSuggestions =
                    parsedResponse?.codeSuggestions?.map((suggestion) => ({
                        ...suggestion,
                        relevantLinesStart:
                            Number(suggestion.relevantLinesStart) || undefined,
                        relevantLinesEnd:
                            Number(suggestion.relevantLinesEnd) || undefined,
                    }));
            }

            return {
                codeSuggestions: parsedResponse?.codeSuggestions || [],
            };
        } catch (error) {
            this.logger.error({
                message: `${LLM_ERROR_TAG} Error processing LLM response for PR#${prNumber}`,
                context: 'LLMResponseProcessor',
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    response,
                },
            });
            return null;
        }
    }

    public processReviewModeResponse(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: string,
    ): { reviewMode: ReviewModeResponse } {
        try {
            let cleanResponse = response;

            // If the response is in markdown format (Claude), remove the markers
            if (response?.startsWith('```')) {
                cleanResponse = response
                    .replace(/^```json\n/, '')
                    .replace(/\n```$/, '')
                    .trim();
            }

            // Attempt to parse the JSON
            const parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse) {
                this.logger.error({
                    message: `${LLM_ERROR_TAG} ${LLM_ENVELOPE_TAG} Failed to parse review mode response`,
                    context: 'LLMResponseProcessor',
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                    },
                });
                return { reviewMode: ReviewModeResponse.HEAVY_MODE };
            }

            return {
                reviewMode:
                    parsedResponse?.reviewMode === 'light_mode'
                        ? ReviewModeResponse.LIGHT_MODE
                        : ReviewModeResponse.HEAVY_MODE,
            };
        } catch (error) {
            this.logger.error({
                message: `${LLM_ERROR_TAG} Error processing review mode response for PR#${prNumber}`,
                context: 'LLMResponseProcessor',
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    response,
                },
            });
            return { reviewMode: ReviewModeResponse.HEAVY_MODE };
        }
    }
}
