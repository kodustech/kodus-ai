import { z } from 'zod';

import {
    getChatGPT,
    traceCustomLLMCall,
} from '@/shared/utils/langchainCommon/document';
import zodToJsonSchema from 'zod-to-json-schema';
import { JsonOutputFunctionsParser } from 'langchain/output_parsers';
import { Inject } from '@nestjs/common';
import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import {
    DetermineRouteParams,
    ExecutionRouterPromptParams,
    RouterPromptParams,
} from '@/config/types/general/agentRouter.type';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    SystemMessagePromptTemplate,
} from '@langchain/core/prompts';
import { createMemoryInstance } from '@/shared/utils/langchainCommon/conversationChatMemory';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import { PromptService } from '../../prompt.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { getGemini } from '@/shared/utils/googleGenAI';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { CommunicationStyle } from '@/shared/domain/enums/communication-style.enum';
import { PinoLoggerService } from '../../logger/pino.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import {
    AGENT_EXECUTION_SERVICE_TOKEN,
    IAgentExecutionService,
} from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import { IAgentExecution } from '@/core/domain/agents/interfaces/agent-execution.interface';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';

export class PromptRouter {
    constructor(
        @Inject('AGENT_STRATEGIES')
        private readonly strategies: Record<string, IAgentRouterStrategy>,

        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(AGENT_EXECUTION_SERVICE_TOKEN)
        private readonly agentExecutionService: IAgentExecutionService,

        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly promptService: PromptService,
        private logger: PinoLoggerService,
    ) {}

    async routerPrompt(routerPromptParams: RouterPromptParams) {
        try {
            if (!routerPromptParams.route) {
                routerPromptParams = await this.determineRoute({
                    message: routerPromptParams.message,
                    memory: JSON.stringify(routerPromptParams.memory),
                    sessionId: routerPromptParams.sessionId,
                    organizationAndTeamData:
                        routerPromptParams?.organizationAndTeamData,
                });
            }

            return routerPromptParams;
        } catch (error) {
            this.logger.error({
                message: 'Error while executing routerPrompt',
                context: 'routerPrompt',
                error: error,
                metadata: {
                    routerPromptParams,
                },
            });
        }
    }

    async executionRouterPrompt(
        executionRouterPromptParams: ExecutionRouterPromptParams,
    ): Promise<any> {
        try {
            const agentStrategy = this.getStrategy(
                executionRouterPromptParams.router.route,
            );

            const { response } = await agentStrategy.run({
                message: executionRouterPromptParams.message,
                userId: executionRouterPromptParams.userId,
                channel: executionRouterPromptParams.channel,
                sessionId: executionRouterPromptParams.sessionId,
                userName: executionRouterPromptParams.userName,
                organizationAndTeamData:
                    executionRouterPromptParams.organizationAndTeamData,
                parameters: executionRouterPromptParams?.router?.parameters,
                platformType: executionRouterPromptParams?.platformType,
                metaData: executionRouterPromptParams?.metaData,
            });

            if (!response) {
                return 'Something went wrong while processing your request. Please try again.';
            }

            let finalResultForUser = '';

            if (typeof response === 'object' && response !== null) {
                finalResultForUser = response;
            } else {
                const integrations =
                    await this.integrationService.getPlatformIntegration(
                        executionRouterPromptParams?.organizationAndTeamData,
                    );

                finalResultForUser = await this.formatMessage(
                    executionRouterPromptParams.organizationAndTeamData,
                    response,
                    integrations.communication as PlatformType,
                );
            }

            this.saveAgentExecution({
                message: executionRouterPromptParams?.message,
                responseMessage: response || 'NOT RESPONSE LLM',
                teamId: executionRouterPromptParams?.organizationAndTeamData
                    ?.teamId,
                agentName: executionRouterPromptParams?.router?.route,
                platformUserId: executionRouterPromptParams?.userId,
                sessionId: executionRouterPromptParams?.sessionId,
                platformName: executionRouterPromptParams?.platformType,
                metaData: executionRouterPromptParams?.metaData,
            });

            return finalResultForUser;
        } catch (error) {
            this.logger.error({
                message: 'Error while executing executionRouterPrompt',
                context: 'executionRouterPrompt',
                error: error,
                metadata: {
                    executionRouterPromptParams,
                },
            });
        }
    }

    private async determineRoute(
        determineRouteParams: DetermineRouteParams,
    ): Promise<RouterPromptParams> {
        try {
            const zodSchema = z.object({
                route: z
                    .enum(['projectInsights', 'genericQuery'])
                    .describe('The name of the action mentioned in the text.'),
            });

            const prompt = new ChatPromptTemplate({
                promptMessages: [
                    SystemMessagePromptTemplate.fromTemplate(
                        `Please select an appropriate route based on the provided user input and conversation memory:

                        - projectInsights:
                            - **When to choose**: When the user is seeking insights or explanations about the overall project, team performance or request for task (one or more) information or insights, including project-wide metrics, team health, or strategic issues.
                            - **Choosing signals**: Look for keywords or phrases that indicate a focus on project or team-level concerns, such as "project metrics", "team performance", "lead time", "throughput", "sprint review", "retrospective insights", "bug rate", and other terms related to project management methodologies (e.g., Agile, Scrum, Kanban).
                            - **Example**:
                                - "Can you provide an overview of the team's performance this quarter?"
                                - "Why has our lead time decreased last month?"
                                - "What factors contributed to our increased throughput?"
                                - "Can we analyze the trend in new bugs introduced in the recent sprints?"
                                - "What are the key metrics indicating our project health?"
                                - "How can we improve our sprint velocity based on the last retrospective?"
                                - "How is the aging for task GE-18?"
                                - "What is the delivery date for task JRA-22?"

                        - genericQuery:
                            - **When to choose**: When the user's request involves general questions or mundane tasks that do not fit into other specific categories.
                            - **Choosing signals**: Look for general questions, simple calculations, or non-specific queries.
                            - **Example**:
                                - "What is 2+2?"
                                - "Can you tell me a fun fact?"
                                - "What is the capital of France?"

                        Ensure to evaluate the user input and conversation memory thoroughly to select the most fitting route. The input is most important thant memory to decide.
                        `,
                    ),
                    HumanMessagePromptTemplate.fromTemplate(
                        'UserMessage: {inputText}, \n ConversationMemory: {memory}',
                    ),
                ],
                inputVariables: ['inputText', 'memory'],
            });

            const chat = getChatGPT({
                model: getLLMModelProviderWithFallback(
                    LLMModelProvider.CHATGPT_4_TURBO,
                ),
            });
            const functionCallingModel = chat.bind({
                functions: [
                    {
                        name: 'output_formatter',
                        description:
                            'Should always be used to properly format output',
                        parameters: zodToJsonSchema(zodSchema),
                    },
                ],
                function_call: { name: 'output_formatter' },
            });

            const outputParser = new JsonOutputFunctionsParser();
            const chain = prompt
                .pipe(functionCallingModel as any)
                .pipe(outputParser);

            const collection = this.memoryService.getNativeCollection();
            const memory = createMemoryInstance(
                collection,
                determineRouteParams,
                2,
            );

            const { history } = await memory.loadMemoryVariables({});

            const data: any = await chain.invoke(
                {
                    inputText: determineRouteParams.message,
                    memory: JSON.stringify(history),
                },
                {
                    metadata: {
                        module: 'Router',
                        teamId: '',
                        sessionId: determineRouteParams?.sessionId,
                    },
                },
            );

            return data;
        } catch (error) {
            this.logger.error({
                message: 'Error while executing determineRoute',
                context: 'determineRoute',
                error: error,
                metadata: {
                    determineRouteParams,
                },
            });
        }
    }

    private getStrategy(route: string): IAgentRouterStrategy {
        const agentStrategy = this.strategies[route];

        if (!agentStrategy) {
            throw new Error(`No strategy found for route: ${route}`);
        }
        return agentStrategy;
    }

    private async formatMessage(
        organizationAndTeamData: OrganizationAndTeamData,
        message: string,
        platform: PlatformType,
    ) {
        const conversationStyle = await this.getConversationStyle(
            organizationAndTeamData,
        );

        const language = await this.getLanguage(organizationAndTeamData);

        const promptName = this.getPromptNameForIntegration(platform);

        const promptFormatter =
            await this.promptService.getCompleteContextPromptByName(
                promptName,
                {
                    organizationAndTeamData,
                    payload: {
                        inputMessage: message,
                        conversationStyle: conversationStyle,
                        language: language,
                    },
                    promptIsForChat: false,
                },
            );

        const gemini = await getGemini({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.GEMINI_1_5_PRO_EXP,
            ),
            temperature: 0,
        });
        let response = '';

        try {
            response = (
                await gemini.sendMessage(promptFormatter)
            ).response.text();

            traceCustomLLMCall(
                promptFormatter,
                response,
                'FormatterMessage',
                getLLMModelProviderWithFallback(
                    LLMModelProvider.GEMINI_1_5_PRO_EXP,
                ),
            );
        } catch (error) {
            response = message;

            this.logger.error({
                message: 'Error while executing formatting prompt',
                context: 'FormatterMessage',
                error: error,
                metadata: {
                    teamId: organizationAndTeamData.teamId,
                },
            });
        }

        return response;
    }

    private async getConversationStyle(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        let conversationStyle = null;

        if (organizationAndTeamData && organizationAndTeamData.teamId) {
            conversationStyle = await this.parametersService.findByKey(
                ParametersKey.COMMUNICATION_STYLE,
                organizationAndTeamData,
            );
        }

        if (
            !conversationStyle ||
            conversationStyle?.configValue?.style === CommunicationStyle.CONCISE
        ) {
            return `- Always communicate concisely, directly and straight to the point.
            - Avoid unnecessary verbosity or complex language.
            - Focus on delivering clear, straightforward responses.
            - Prioritize brevity without sacrificing clarity.
            - Omit pleasantries or filler phrases.`;
        }

        return `- Adopt a coach-like tone: patient, encouraging, and insightful.
    - Explain reasoning clearly without overwhelming detail.
    - Highlight key insights and their practical applications.
    - Use relatable analogies for complex concepts when helpful.
    - Encourage critical thinking with strategic questions.
    - Adapt explanations to the user's apparent understanding.
    - Offer constructive feedback positively.
    - Celebrate progress and promote continuous improvement.
    - Balance empathy with pushing for growth.
    - Foster curiosity and practical application of concepts.`;
    }

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
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

        return language?.configValue;
    }

    private getPromptNameForIntegration(integration: string) {
        switch (integration?.toUpperCase()) {
            case PlatformType.DISCORD:
                return 'prompt_discord_format';
            case PlatformType.SLACK:
                return 'prompt_slack_format';
            default:
                return 'prompt_slack_format';
        }
    }

    private saveAgentExecution(data: Omit<IAgentExecution, 'uuid'>): void {
        setImmediate(async () => {
            try {
                this.agentExecutionService.register(data);
            } catch (error) {
                throw new Error('CodeReviewAgent Save Agent Execution', error);
            }
        });
    }
}
