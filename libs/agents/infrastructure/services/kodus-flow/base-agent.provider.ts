import {
    createDirectLLMAdapter,
    LLMAdapter,
    toHumanAiMessages,
} from '@kodus/flow';
import {
    LLMModelProvider,
    BYOKConfig,
    PromptRunnerService,
    PromptRole,
    ParserType,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

@Injectable()
export abstract class BaseAgentProvider {
    protected byokConfig?: BYOKConfig;
    protected organizationAndTeamData?: OrganizationAndTeamData;

    protected abstract readonly defaultLLMConfig: {
        llmProvider: LLMModelProvider;
        temperature: number;
        maxTokens: number;
        maxReasoningTokens: number;
        stop: string[] | undefined;
    };

    /**
     * Abstract method to create MCP adapter
     * Each agent can implement its own filtering logic
     */
    protected abstract createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;

    constructor(
        protected readonly promptRunnerService: PromptRunnerService,
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
    ) {}

    /**
     * Fetches BYOK configuration for the organization.
     *
     * `byokModelOverride` is the per-repository/directory model resolved by
     * the code review pipeline (`codeReviewConfig.byokModel`). `getBYOKConfig()`
     * returns the raw org-level config, so without applying it here an agent
     * invoked during a review would run on the BYOK-settings main model and
     * ignore the override. Empty/absent means "inherit" (no override).
     */
    protected async fetchBYOKConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        byokModelOverride?: string,
    ): Promise<void> {
        this.organizationAndTeamData = organizationAndTeamData;

        const byokConfig =
            await this.permissionValidationService.getBYOKConfig(
                organizationAndTeamData,
            );

        const overrideModel = byokModelOverride?.trim();
        this.byokConfig =
            overrideModel && byokConfig?.main
                ? {
                      ...byokConfig,
                      main: { ...byokConfig.main, model: overrideModel },
                  }
                : byokConfig;
    }

    /**
     * Creates an LLM adapter with BYOK support, metadata tracking, and proper error handling
     */
    protected createLLMAdapter(
        moduleName: string,
        runName: string,
    ): LLMAdapter {
        const wrappedLLM = {
            name: 'agent-configurable-llm',
            call: async (messages: any[], options: any = {}) => {
                const lcMessages = toHumanAiMessages(messages);

                const resolveProvider = (model?: string): LLMModelProvider => {
                    return (
                        (model && (model as any)) ||
                        this.defaultLLMConfig.llmProvider
                    );
                };

                const provider = resolveProvider(options?.model);
                const fallbackProvider = LLMModelProvider.OPENAI_GPT_4O;

                const promptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    provider,
                    fallbackProvider,
                    this.byokConfig,
                );

                const spanName = `${moduleName}::${runName}`;
                const spanAttrs = {
                    type: promptRunner.executeMode,
                    organizationId:
                        this.organizationAndTeamData?.organizationId,
                    // prNumber: this?.number,
                };

                const { result } = await this.observabilityService.runLLMInSpan(
                    {
                        spanName,
                        runName,
                        attrs: spanAttrs,
                        byokConfig: this.byokConfig,
                        exec: async (callbacks) => {
                            let builder = promptRunner
                                .builder()
                                .setParser(ParserType.STRING)
                                .setPayload({});

                            for (const msg of lcMessages) {
                                const role =
                                    msg.type === 'system'
                                        ? PromptRole.SYSTEM
                                        : PromptRole.USER;

                                builder = builder.addPrompt({
                                    prompt: msg.content,
                                    role: role,
                                });
                            }
                            return await builder
                                .setTemperature(
                                    options?.temperature ??
                                        this.defaultLLMConfig.temperature,
                                )
                                .setMaxTokens(
                                    options?.maxTokens ??
                                        this.defaultLLMConfig.maxTokens,
                                )
                                .setMaxReasoningTokens(
                                    options?.maxReasoningTokens ??
                                        this.defaultLLMConfig
                                            .maxReasoningTokens,
                                )
                                .addMetadata({
                                    module: moduleName,
                                    submodule: 'kodus-flow',
                                    organizationId:
                                        this.organizationAndTeamData
                                            ?.organizationId,
                                    teamId: this.organizationAndTeamData
                                        ?.teamId,
                                    provider:
                                        this.byokConfig?.main?.provider ||
                                        provider,
                                    fallbackProvider:
                                        this.byokConfig?.fallback?.provider ||
                                        fallbackProvider,
                                    model:
                                        this.byokConfig?.main?.model ||
                                        provider,
                                    fallbackModel:
                                        this.byokConfig?.fallback?.model ||
                                        fallbackProvider,
                                    type: promptRunner.executeMode,
                                })
                                .addCallbacks(callbacks)
                                .setRunName(`${moduleName}`)
                                .execute();
                        },
                    },
                );

                return {
                    content: result,
                    additional_kwargs: {},
                };
            },
        };

        return createDirectLLMAdapter(wrappedLLM);
    }
}
