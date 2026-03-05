import { createLogger } from '@kodus/flow';
import { tryParseJSONObject } from '@libs/common/utils/transforms/json';

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
            let cleanResponse = response;

            // If the response is in markdown format (Claude), remove the markers
            if (response?.startsWith('```')) {
                cleanResponse = response
                    .replace(/^```json\n/, '')
                    .replace(/\n```$/, '')
                    .trim();
            }

            // Attempt to parse the JSON — validator picks the first block
            // containing codeSuggestions when multiple code blocks exist
            const parsedResponse = tryParseJSONObject(cleanResponse, (obj) =>
                Array.isArray(obj?.codeSuggestions),
            );

            if (!parsedResponse) {
                this.logger.error({
                    message: 'Failed to parse LLM response',
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
                message: `Error processing LLM response for PR#${prNumber}`,
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
                    message: 'Failed to parse review mode response',
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
                message: `Error processing review mode response for PR#${prNumber}`,
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
