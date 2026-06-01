import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
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
        private readonly promptRunnerService: PromptRunnerService,
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
        const provider = LLMModelProvider.GROQ_GPT_OSS_120B;
        const fallbackProvider = LLMModelProvider.OPENAI_GPT_4O_MINI;
        const runName = 'validateWithLLM';
        const spanName = `${SuggestionLLMValidator.name}::${runName}`;

        const spanAttrs = {
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            filePath: payload.filePath,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await this.promptRunnerService
                        .builder()
                        .setProviders({
                            main: provider,
                            fallback: fallbackProvider,
                        })
                        .setParser(ParserType.ZOD, validateCodeSemanticsSchema)
                        .setLLMJsonMode(true)
                        .setPayload(payload)
                        .addPrompt({
                            role: PromptRole.USER,
                            prompt: prompt_validateCodeSemantics,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            provider,
                            fallbackProvider,
                            runName,
                        })
                        .setTemperature(0)
                        .setRunName(runName)
                        .execute();
                },
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
        const runName = 'checkSuggestionSimplicity';
        const provider = LLMModelProvider.GEMINI_2_5_FLASH;
        const fallbackProvider = LLMModelProvider.OPENAI_GPT_4O_MINI;

        const spanName = `${SuggestionLLMValidator.name}::${runName}`;
        const spanAttrs = {
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await this.promptRunnerService
                        .builder()
                        .setProviders({
                            main: provider,
                            fallback: fallbackProvider,
                        })
                        .setParser(
                            ParserType.ZOD,
                            checkSuggestionSimplicitySchema,
                        )
                        .setLLMJsonMode(true)
                        .setTemperature(0)
                        .setPayload({
                            language: suggestion.language || 'text',
                            existingCode: suggestion.existingCode || '',
                            improvedCode: suggestion.improvedCode || '',
                        })
                        .addPrompt({
                            prompt: prompt_checkSuggestionSimplicity_system,
                            role: PromptRole.SYSTEM,
                        })
                        .addPrompt({
                            prompt: prompt_checkSuggestionSimplicity_user,
                            role: PromptRole.USER,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            provider,
                            fallbackProvider,
                            runName,
                            suggestionId: suggestion.id,
                        })
                        .setRunName(runName)
                        .execute();
                },
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
