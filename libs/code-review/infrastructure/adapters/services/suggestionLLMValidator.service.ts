import { Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import {
    prompt_validateCodeSemantics,
    ValidateCodeSemanticsResult,
    validateCodeSemanticsSchema,
} from '@libs/common/utils/langchainCommon/prompts/validateCodeSemantics';
import {
    checkSuggestionSimplicitySchema,
    prompt_checkSuggestionSimplicity_system,
    prompt_checkSuggestionSimplicity_user,
} from '@libs/common/utils/langchainCommon/prompts/checkSuggestionSimplicity';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';

@Injectable()
export class SuggestionLLMValidator {
    private readonly logger = createLogger(SuggestionLLMValidator.name);

    constructor(
        private readonly observabilityService: ObservabilityService,
    ) {}

    async validateWithLLM(
        payload: {
            code: string;
            filePath: string;
            language?: string;
            diff?: string;
        },
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<ValidateCodeSemanticsResult | null> {
        const runName = `${SuggestionLLMValidator.name}::validateWithLLM`;

        try {
            // Migrated off the kodus-common LangChain PromptRunner path onto the
            // AI SDK path (REQ-NOLC-01). byokConfig is undefined here →
            // runStructuredReviewCall resolves the managed review default; the
            // previous GROQ_GPT_OSS_120B/OPENAI_GPT_4O_MINI provider pin is
            // intentionally dropped (RESEARCH Pattern 1 — consolidation to the
            // managed default; per-task routing is Phase 4). The outer LangChain
            // span wrapper is dropped — runStructuredReviewCall owns the single
            // span path (Q4). setTemperature(0) is likewise dropped (not threaded).
            const result = await runStructuredReviewCall({
                schema: validateCodeSemanticsSchema,
                system: '',
                user: prompt_validateCodeSemantics(payload),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                attrs: {
                    prNumber,
                    filePath: payload.filePath,
                    teamId: organizationAndTeamData?.teamId,
                },
                observabilityService: this.observabilityService,
                byokConfig: undefined,
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error executing LLM validation',
                context: SuggestionLLMValidator.name,
                metadata: {
                    filePath: payload.filePath,
                    organizationAndTeamData,
                    prNumber,
                },
                error,
            });
            return null;
        }
    }

    async checkSuggestionSimplicity(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestion: Partial<CodeSuggestion>,
    ): Promise<{ isSimple: boolean; reason?: string }> {
        const runName = `${SuggestionLLMValidator.name}::checkSuggestionSimplicity`;

        try {
            // Migrated off the kodus-common LangChain PromptRunner path onto the
            // AI SDK path (REQ-NOLC-01). byokConfig undefined → managed default;
            // the previous GEMINI_2_5_FLASH/OPENAI_GPT_4O_MINI provider pin
            // is intentionally dropped (RESEARCH Pattern 1 — consolidation; routing
            // is Phase 4). Outer LangChain span wrapper dropped — one span path via
            // runStructuredReviewCall (Q4). setTemperature(0) dropped (not threaded).
            const result = await runStructuredReviewCall({
                schema: checkSuggestionSimplicitySchema,
                system: prompt_checkSuggestionSimplicity_system(),
                user: prompt_checkSuggestionSimplicity_user({
                    language: suggestion.language || 'text',
                    existingCode: suggestion.existingCode || '',
                    improvedCode: suggestion.improvedCode || '',
                }),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                attrs: {
                    prNumber,
                    teamId: organizationAndTeamData?.teamId,
                    suggestionId: suggestion.id,
                },
                observabilityService: this.observabilityService,
                byokConfig: undefined,
            });

            if (!result) {
                this.logger.warn({
                    message:
                        'No result from LLM when checking suggestion simplicity',
                    context: SuggestionLLMValidator.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        suggestionId: suggestion.id,
                    },
                });

                return { isSimple: false, reason: 'No result from LLM' };
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error checking suggestion simplicity',
                error,
                context: SuggestionLLMValidator.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    suggestionId: suggestion.id,
                },
            });

            return { isSimple: false, reason: 'Error during check' };
        }
    }
}
