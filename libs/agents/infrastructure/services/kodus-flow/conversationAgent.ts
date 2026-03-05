import {
    createLogger,
    createMCPAdapter,
    createOrchestration,
    LLMAdapter,
    PlannerType,
    Thread,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';
import { BaseAgentProvider } from './base-agent.provider';

@Injectable()
export class ConversationAgentProvider extends BaseAgentProvider {
    private readonly logger = createLogger(ConversationAgentProvider.name);
    private orchestration: SDKOrchestrator;
    private mcpAdapter: ReturnType<typeof createMCPAdapter>;
    private llmAdapter: LLMAdapter;
    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_PRO,
        temperature: 0,
        maxTokens: 20000,
        maxReasoningTokens: 800,
        stop: undefined as string[] | undefined,
    };

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    protected async createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const mcpManagerServers = await this.mcpManagerService.getConnections(
            organizationAndTeamData,
        );

        if (!mcpManagerServers?.length) {
            this.logger.warn({
                message:
                    'ConversationAgent: no MCP connections available for this organization/team. Skipping MCP adapter initialization.',
                context: ConversationAgentProvider.name,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    teamId: organizationAndTeamData?.teamId,
                },
            });
            this.mcpAdapter = undefined;
            return;
        }

        const servers = [...mcpManagerServers];

        this.mcpAdapter = createMCPAdapter({
            servers,
            defaultTimeout: 60_000,
            maxRetries: 1,
            onError: (err) => {
                this.logger.warn({
                    message:
                        'ConversationAgent: MCP execution failed, continuing.',
                    context: ConversationAgentProvider.name,
                    error: new Error(err.message),
                });
            },
        });
    }

    private async createOrchestration() {
        this.llmAdapter = super.createLLMAdapter(
            'ConversationalAgent',
            'conversationAgent',
        );

        this.orchestration = await createOrchestration({
            tenantId: 'kodus-agent-conversation',
            llmAdapter: this.llmAdapter,
            mcpAdapter: this.mcpAdapter,
            observability:
                this.observabilityService.getAgentObservabilityConfig(
                    'kodus-flow',
                ),
            storage: this.observabilityService.getStorageConfig(),
        });
    }

    private async initialize(
        organizationAndTeamData: OrganizationAndTeamData,
        userLanguage: string,
    ) {
        await this.createMCPAdapter(organizationAndTeamData);
        await this.createOrchestration();

        try {
            await this.orchestration.connectMCP();
            await this.orchestration.registerMCPTools();
        } catch (error) {
            this.logger.warn({
                message: 'MCP offline, prosseguindo.',
                context: ConversationAgentProvider.name,
                error,
            });
        }

        await this.orchestration.createAgent({
            name: 'kodus-conversational-agent',
            identity: {
                description:
                    'Intelligent conversation agent for user interactions.',
                goal: 'Engage in natural, helpful conversations while respecting user language preferences',
                language: userLanguage,
                languageInstructions: `LANGUAGE REQUIREMENTS:
- Respond in the user's preferred language: ${userLanguage}
- Default to English if no language preference is configured
- Maintain consistent language throughout conversation
- Use appropriate terminology and formatting for the selected language
- Adapt communication style to the target language conventions`,
            },
            plannerOptions: {
                type: PlannerType.REACT,
                replanPolicy: {
                    toolUnavailable: 'replan',
                    maxReplans: 3,
                },
            },
        });
    }

    // -------------------------------------------------------------------------
    async execute(
        prompt: string,
        context?: {
            organizationAndTeamData: OrganizationAndTeamData;
            prepareContext?: any;
            thread?: Thread;
        },
    ) {
        const { organizationAndTeamData, prepareContext, thread } =
            context || ({} as any);
        try {
            if (
                !organizationAndTeamData ||
                !organizationAndTeamData.organizationId
            ) {
                throw new Error(
                    'Organization and team data with organizationId is required.',
                );
            }

            if (!thread) {
                throw new Error('thread and team data is required.');
            }

            const userLanguage = await this.getLanguage(
                organizationAndTeamData,
            );

            this.logger.log({
                message: 'Starting conversation agent execution',
                context: ConversationAgentProvider.name,
                serviceName: ConversationAgentProvider.name,
                metadata: { organizationAndTeamData, thread, userLanguage },
            });

            await this.fetchBYOKConfig(organizationAndTeamData);

            await this.initialize(organizationAndTeamData, userLanguage);

            const preparedPrompt = this.buildPromptWithMemoryBootstrap(
                prompt,
                prepareContext,
                organizationAndTeamData,
            );

            const result = await this.orchestration.callAgent(
                'kodus-conversational-agent',
                preparedPrompt,
                {
                    thread: thread,
                    userContext: {
                        organizationAndTeamData: organizationAndTeamData,
                        additional_information: prepareContext,
                    },
                },
            );

            this.logger.log({
                message: 'Finish conversation agent execution',
                context: ConversationAgentProvider.name,
                serviceName: ConversationAgentProvider.name,
                metadata: {
                    organizationAndTeamData,
                    thread,
                    result: {
                        correlationId: result.context.correlationId ?? null,
                        threadId: result.context.threadId ?? null,
                        sessionId: result.context.sessionId ?? null,
                    },
                },
            });

            return typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
        } catch (error) {
            this.logger.error({
                message: 'Error during conversation agent execution',
                context: ConversationAgentProvider.name,
                serviceName: ConversationAgentProvider.name,
                metadata: { error, organizationAndTeamData, thread },
            });
            throw error;
        }
    }

    private buildPromptWithMemoryBootstrap(
        prompt: string,
        prepareContext: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): string {
        const organizationId =
            organizationAndTeamData?.organizationId?.toString() || '';
        const teamId = organizationAndTeamData?.teamId?.toString() || '';
        const repositoryId = prepareContext?.repository?.id?.toString() || '';

        const memoryPayload = {
            organizationId,
            teamId,
            ...(repositoryId ? { repositoryId } : {}),
            limit: 20,
        };

        const instructions = [
            'CRITICAL FIRST ACTION (MANDATORY):',
            '- Before any reasoning, analysis, or other tool call, invoke KODUS_FIND_MEMORIES.',
            '- Use this exact payload as your first memory lookup:',
            JSON.stringify(memoryPayload, null, 2),
            '- If the tool fails, is unavailable, or returns no matches, continue normally.',
            '- If matches are found, treat them as high-priority context constraints for your response.',
            '',
            'USER PROMPT:',
            prompt,
        ].join('\n');

        return instructions;
    }

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        let language = null;

        if (organizationAndTeamData && organizationAndTeamData.teamId) {
            language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
        }

        if (!language) {
            return 'en-US';
        }

        return language?.configValue || 'en-US';
    }
}
