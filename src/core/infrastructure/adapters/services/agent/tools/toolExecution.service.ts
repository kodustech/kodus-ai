import { Inject, Injectable } from '@nestjs/common';
import {
    ITool,
    ToolExecutionContext,
    TOOLS_TOKEN,
} from './interfaces/ITool.interface';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

import { z } from 'zod';
import { RunnableSequence } from '@langchain/core/runnables';
import { getChatGPT } from '@/shared/utils/langchainCommon/document';
import {
    ChatPromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';
import { createMemoryInstance } from '@/shared/utils/langchainCommon/conversationChatMemory';
import {
    IToolExecutionService,
    ToolsExecutionResult,
} from './interfaces/IToolExecution.interface';
import {
    IToolManagerService,
    TOOL_MANAGER_SERVICE_TOKEN,
} from './interfaces/IToolManager.interface';
import {
    AIMessage,
    HumanMessage,
    SystemMessage,
} from '@langchain/core/messages';

import { tryParseJSONObject } from '@/shared/utils/transforms/json';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';

type Action = {
    id: number;
    type: string;
    parameters?: { [key: string]: any };
    requirements?: [];
};

@Injectable()
export class ToolExecutionService implements IToolExecutionService {
    private toolsRegistry: Map<string, any> = new Map();

    constructor(
        @Inject(TOOLS_TOKEN) private tools: ITool<any, any>[],

        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(TOOL_MANAGER_SERVICE_TOKEN)
        private readonly toolManagerService: IToolManagerService,
    ) {}

    findTools(toolDefinition: string[]): ITool<any, any>[] {
        return this.tools.filter((tool) => toolDefinition.includes(tool.name));
    }

    createExecuteTool(
        toolDefinition: ITool<any, any>,
    ): DynamicStructuredTool<any> {
        try {
            if (!toolDefinition) {
                return;
            }

            const tool = new DynamicStructuredTool({
                name: toolDefinition.name,
                description: toolDefinition.description,
                schema: z.object({}).passthrough() as any,
                func: this.processToolParams,
                metadata: toolDefinition.definition as Record<string, any>,
            });

            this.toolsRegistry.set(toolDefinition.name, tool);

            return tool;
        } catch (error) {
            console.error(error);
        }
    }

    processToolParams(
        toolParams: any,
        initialInput: any,
        runManager: any,
    ): any {
        return {
            name: runManager.runName,
            operation: toolParams.operation,
            params: toolParams.parameters,
            metaData: initialInput.metadata,
            runId: initialInput.runId,
            parentRunId: initialInput._parentRunId,
        };
    }

    bindToolsToModel(model: any, toolDefinitions: ITool<any, any>[]): any {
        const tools = toolDefinitions.map((definition) =>
            this.createExecuteTool(definition),
        );

        const modelWithTools = model.bind({
            tools: tools.map(convertToOpenAITool),
        });

        return modelWithTools;
    }

    private structuredOutputParser(message: AIMessage): Action[] | Error {
        try {
            if (!message.content || typeof message.content !== 'string') {
                throw new Error(
                    'This agent cannot parse non-string model responses.',
                );
            }

            const actions =
                tryParseJSONObject(message.content.toString()) || [];
            return actions as Action[];
        } catch (error) {
            return new Error(
                `Failed to parse function arguments from chat model response. ${error}`,
            );
        }
    }

    async prepareToolInvocationSequence(
        context: ToolExecutionContext,
        toolDefinitions: any,
        memory: any,
    ) {
        const model = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_ALL,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const prompt = await this.getPromptWithToolsDefinition(
            context.message,
            toolDefinitions,
        );

        const chain = RunnableSequence.from([
            {
                input: (initialInput) => initialInput.input,
                memory: () => memory.loadMemoryVariables({}),
            },
            {
                input: (previousOutput) => previousOutput.input,
                history: (previousOutput) => previousOutput.memory.history,
            },
            prompt,
            model,
            this.structuredOutputParser,
        ]).withConfig({
            runName: 'ExecuteSearchTools',
            metadata: {
                organizationId: context.organizationAndTeamData.organizationId,
                teamId: context.organizationAndTeamData.teamId,
            },
        });

        return chain;
    }

    async executeInvocationSequenceWithLLM(
        toolDefinitions: any,
        context: ToolExecutionContext,
    ): Promise<ToolsExecutionResult> {
        const collection = await this.memoryService.getNativeCollection();
        const memory = await createMemoryInstance(collection, context, 2);

        const chain = await this.prepareToolInvocationSequence(
            context,
            toolDefinitions,
            memory,
        );

        const outputParamsTools = await chain.invoke({});

        const result = await this.callAndProcessToolExecution(
            outputParamsTools,
            context,
        );

        return result;
    }

    executeInvocationOnceWithTool(
        toolDefinition: string,
        context: ToolExecutionContext,
        params: any,
    ) {
        throw new Error('Method not implemented.');
    }

    private generateLLMCompilerPrompt(tools: Array<any>): string {
        const toolDefinitions = tools.map((tool, index) => ({
            id: index + 1,
            tool_name: tool.name,
            tool_description: tool.definition.tool_description,
            tool_signals_to_choose: tool.definition.tool_signals_to_choose,
            tool_data_return_structure: JSON.stringify(
                tool.definition.tool_data_return_structure,
            ),
            tool_parameters: JSON.stringify(tool.definition.tool_parameters),
            tool_requirements: tool.definition.tool_requirements || '',
        }));

        return `{
            "prompt": "You are Kody, a software delivery management expert. Your objective is to analyze the available tools and the context according to the user's question to select the ideal combination of tools. Retrieve the requested information in the most efficient way possible. Help the user answer any question.

            To do this, you must consider the following aspects:
            Tool functionality: What type of information does each tool provide? Does it fit the user’s needs?
            Tool parameters: What parameters can be configured to adjust the search and obtain more accurate results?
            Relationship between tools: How do the tools connect? Can the output of one tool be used as input to another?

            Help the user answer any question.

            For user queries, create a plan to resolve them. Each plan must include one or more tools from the following types:
            ${tools.map((tool) => tool.name).join(', ')}

            Let's analyze the user's question:

            ReAct reasoning to solve the question:

            You have access to the following tools:

            ${JSON.stringify(toolDefinitions)}

            Guidelines:
            - Each tool described above contains input/output types and tool_description/tool_signals_to_choose.
            - You must strictly follow the input and output types for each tool.
            - Tool descriptions contain guidelines. You MUST strictly follow these guidelines when using the tools.
            - Each tool MUST have a unique ID, which is strictly ascending.
            - Inputs to tools can be constants or outputs from previous tools.
            - When the tool requires parameters, return to the structure { 'requirements': [1, 2, 3, ...] }, where 1, 2, 3, ... is the id of the tool selected in the tool. In the latter case, use the format $id to denote the ID of the previous tool whose output will be the input.
            - Respect parameters examples.
            - Never explain the plan with comments (e.g. #).
            - Never introduce new tools other than those provided.
            - When a tool has configured the value for tool_requirements, you need to strictly comply with this configuration, because it informs the data/tools that need to be executed first to achieve the best planning for correct execution.

            Configuration example:

            tool_requirements: 'Requires an array of IDs from X data, taken directly from the user message or from GetNameTool. We also need data Y, obtained directly from the user message or from getNameTwoTool.'

            Here are some examples of how you should return according to all instructions given previously.:

            { 'actions': [ { 'id': 1, 'type': 'GetToolName', 'parameters': { 'parameter_param': '{\"operation\":\"operation\"}' } }, { 'id': 2, 'type': 'GetTwoToolName', 'parameters': { 'parameter_ids': '$1' }, 'requirements': [1, 2, 3, ...] } ] }",

            "json_mode": true,
        }`;
    }

    private async getPromptWithToolsDefinition(inputs: any, tools: any[] = []) {
        const systemPrompt = this.generateLLMCompilerPrompt(tools);

        const humanPrompt = `Question: ${inputs}`;

        const messages = [
            new SystemMessage({ content: systemPrompt }),
            new MessagesPlaceholder('history'),
            new HumanMessage({ content: humanPrompt }),
        ];

        return ChatPromptTemplate.fromMessages(messages);
    }

    private filterAndSortToolsExecution(actions: Action[]): any[] {
        const requirementsMap = actions.reduce((acc, action) => {
            acc[action.type] = action.requirements || [];
            return acc;
        }, {});

        const sortedToolsExecution = this.tools
            .filter((tool) =>
                requirementsMap.hasOwnProperty(tool.constructor.name),
            )
            .sort((a, b) => {
                const aRequirements = requirementsMap[a.constructor.name];
                const bRequirements = requirementsMap[b.constructor.name];

                if (
                    aRequirements.includes(
                        actions.find(
                            (action) => action.type === b.constructor.name,
                        )?.id,
                    )
                ) {
                    return 1;
                } else if (
                    bRequirements.includes(
                        actions.find(
                            (action) => action.type === a.constructor.name,
                        )?.id,
                    )
                ) {
                    return -1;
                }

                return 0;
            });

        return sortedToolsExecution;
    }

    private async callAndProcessToolExecution(
        toolsOutpuStructureLLM: any,
        content: ToolExecutionContext,
    ): Promise<ToolsExecutionResult> {
        const { actions: toolsOutputLLM } = toolsOutpuStructureLLM;

        if (!toolsOutputLLM) {
            console.error('No tools output found in the given structure.');
            return {
                results: [],
                nameOfToolsExecuted: [],
            };
        }

        const toolsFormatOutputLLM = this.formatToolsOutputLLM(toolsOutputLLM);
        const toolsExecution = this.filterAndSortToolsExecution(toolsOutputLLM);

        const nameOfToolsExecuted = [];

        for (const toolExecution of toolsExecution) {
            nameOfToolsExecuted.push(toolExecution.name);

            const toolOutputLLM = toolsFormatOutputLLM.find(
                (tool) => tool.type === toolExecution.name,
            );

            if (toolOutputLLM?.requirements?.length <= 0) {
                await this.executeTool(toolExecution, toolOutputLLM, content);
            }

            if (
                toolOutputLLM?.requirements.length > 0 &&
                this.toolManagerService.areRequirementsSatisfied(
                    toolOutputLLM?.requirements.map((req) => req.name),
                )
            ) {
                const executedTool = this.toolManagerService.getToolResults(
                    toolOutputLLM?.requirements.map((req) => req.name),
                    'jsonResult',
                );

                const newInputFromExecutedTool = {
                    ...toolOutputLLM,
                    parameters: {
                        ...toolOutputLLM.parameters,
                        ...executedTool,
                    },
                };

                await this.executeTool(
                    toolExecution,
                    newInputFromExecutedTool,
                    content,
                );
            }
        }

        const results = await this.toolManagerService.getToolResults(
            nameOfToolsExecuted,
            'stringResult',
        );

        return results
            ? {
                  results: Object.values(results),
                  nameOfToolsExecuted,
              }
            : { results: [], nameOfToolsExecuted };
    }

    private formatToolsOutputLLM(toolsOutputLLM: any[]): any[] {
        return toolsOutputLLM.map((tool) => {
            const formattedRequirements =
                tool.requirements?.map((reqId) => {
                    const requirement = toolsOutputLLM.find(
                        ({ id }) => id === reqId,
                    );
                    return {
                        id: reqId,
                        name: requirement?.type,
                        parameters: requirement?.parameters,
                    };
                }) || [];

            return { ...tool, requirements: formattedRequirements };
        });
    }

    private async executeTool(toolExecution, toolOutputLLM, content) {
        try {
            const result = await toolExecution.execute(toolOutputLLM, content);

            if (result) {
                this.toolManagerService.markAsExecuted(
                    toolExecution.name,
                    result,
                );
            }

            return result;
        } catch (error) {
            console.error(`Error executing tool ${toolExecution.name}:`, error);
            throw error;
        }
    }
}
