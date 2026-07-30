import { createLogger } from '@libs/core/log/logger';
import {
    LLMModelProvider,
    PromptRunnerService,
    ParserType,
    PromptRole,
    BYOKConfig,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { environment } from '../configs/environment';
import {
    prompt_kodyissues_merge_suggestions_into_issues_system,
    prompt_kodyissues_resolve_issues_system,
} from '@libs/common/utils/langchainCommon/prompts/kodyIssuesManagement';
import { contextToGenerateIssues } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';
import { tryParseJSONObject } from '@libs/common/utils/transforms/json';

export const KODY_ISSUES_ANALYSIS_SERVICE_TOKEN = Symbol(
    'KodyIssuesAnalysisService',
);

@Injectable()
export class KodyIssuesAnalysisService {
    private readonly logger = createLogger(KodyIssuesAnalysisService.name);
    public readonly isCloud: boolean;
    public readonly isDevelopment: boolean;

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {
        this.isCloud = environment.API_CLOUD_MODE;
        this.isDevelopment = environment.API_DEVELOPMENT_MODE;
    }

    async mergeSuggestionsIntoIssues(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: any,
        promptData: any,
        byokConfig: BYOKConfig | null,
    ): Promise<any> {
        try {
            const provider = LLMModelProvider.GEMINI_2_5_PRO;
            // Fallback to a Vertex (SA-auth) model so a failure of the AI
            // Studio Gemini key falls through to the enterprise Vertex
            // account. Must be a Gemini model: the legacy v2 engine builds
            // Vertex models via `ChatVertexAI`, which only speaks the Gemini
            // protocol. `VERTEX_CLAUDE_3_5_SONNET` was silently broken here
            // (Claude on Vertex needs the Anthropic protocol). Claude on
            // Vertex is supported via BYOK (v5) only.
            const fallbackProvider = LLMModelProvider.VERTEX_GEMINI_2_5_PRO;
            const runName = 'mergeSuggestionsIntoIssues';

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                provider,
                fallbackProvider,
                byokConfig,
            );
            const spanName = `${KodyIssuesAnalysisService.name}::${runName}`;
            const spanAttrs = {
                type: promptRunner.executeMode,
                organizationId: organizationAndTeamData?.organizationId,
                prNumber: pullRequest?.number,
            };

            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                byokConfig,
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setPayload(promptData)
                        .addPrompt({
                            prompt: prompt_kodyissues_merge_suggestions_into_issues_system,
                            role: PromptRole.SYSTEM,
                        })
                        .addPrompt({
                            prompt: (input) => JSON.stringify(input),
                            role: PromptRole.USER,
                        })
                        .addMetadata({
                            organizationAndTeamData,
                            prNumber: pullRequest?.number,
                            provider: byokConfig?.main?.provider || provider,
                            fallbackProvider:
                                byokConfig?.fallback?.provider ||
                                fallbackProvider,
                            model: byokConfig?.main?.model,
                            fallbackModel: byokConfig?.fallback?.model,
                            runName,
                        })
                        .addTags([
                            ...this.buildTags(provider, 'primary'),
                            ...this.buildTags(fallbackProvider, 'fallback'),
                        ])
                        .addCallbacks(callbacks)
                        .setRunName(runName)
                        .setTemperature(0)
                        .execute();
                },
            });

            if (!result) {
                const message = `No response from LLM for PR#${pullRequest.number}`;
                this.logger.warn({
                    message,
                    context: KodyIssuesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: pullRequest.number,
                    },
                });
                throw new Error(message);
            }

            return this.processLLMResponse(
                result,
                organizationAndTeamData.organizationId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error in mergeSuggestionsIntoIssues',
                context: KodyIssuesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest.number,
                },
            });
            throw error;
        }
    }

    async resolveExistingIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        promptData: any,
        byokConfig: BYOKConfig | null,
    ): Promise<any> {
        try {
            const provider = LLMModelProvider.GEMINI_2_5_PRO;
            const fallbackProvider = LLMModelProvider.NOVITA_DEEPSEEK_V3;
            const runName = 'resolveExistingIssues';

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                provider,
                fallbackProvider,
                byokConfig,
            );

            const spanName = `${KodyIssuesAnalysisService.name}::${runName}`;
            const spanAttrs = {
                type: promptRunner.executeMode,
                organizationId: context.organizationAndTeamData?.organizationId,
                prNumber: context.pullRequest?.number,
            };

            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                byokConfig,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setPayload(promptData)
                        .addPrompt({
                            prompt: prompt_kodyissues_resolve_issues_system,
                            role: PromptRole.SYSTEM,
                        })
                        .addPrompt({
                            prompt: (input) => JSON.stringify(input),
                            role: PromptRole.USER,
                        })
                        .addMetadata({
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            prNumber: context.pullRequest.number,
                            provider: byokConfig?.main?.provider || provider,
                            fallbackProvider:
                                byokConfig?.fallback?.provider ||
                                fallbackProvider,
                            model: byokConfig?.main?.model,
                            fallbackModel: byokConfig?.fallback?.model,
                            runName,
                        })
                        .addCallbacks(callbacks) // captures usage/token per provider
                        .setRunName(runName)
                        .setTemperature(0)
                        .execute();
                },
            });

            if (!result) {
                const message = `No response from LLM for PR#${context.pullRequest.number}`;
                this.logger.warn({
                    message,
                    context: KodyIssuesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });
                throw new Error(message);
            }

            return this.processLLMResponse(
                result,
                context.organizationAndTeamData.organizationId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error in resolveExistingIssues',
                context: KodyIssuesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });
            throw error;
        }
    }

    private buildTags(
        provider: LLMModelProvider,
        tier: 'primary' | 'fallback',
    ) {
        return [`model:${provider}`, `tier:${tier}`, 'kodyIssues'];
    }

    private processLLMResponse(response: string, organizationId: string): any {
        try {
            if (!response) {
                return null;
            }

            let cleanResponse = response;
            if (response.startsWith('```')) {
                cleanResponse = response
                    .replace(/^```json\n/, '')
                    .replace(/\n```(\n)?$/, '')
                    .trim();
            }

            const parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse) {
                this.logger.error({
                    message: 'Failed to parse LLM response',
                    context: KodyIssuesAnalysisService.name,
                    metadata: { originalResponse: response, organizationId },
                });
                return null;
            }

            return parsedResponse;
        } catch (error) {
            this.logger.error({
                message: 'Error processing LLM response',
                context: KodyIssuesAnalysisService.name,
                error,
                metadata: { response, organizationId },
            });
            return null;
        }
    }
}
