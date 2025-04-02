import { Inject, Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { PinoLoggerService } from '../../../../logger/pino.service';

import { IAIAnalysisService } from '../../../../../../../domain/codeBase/contracts/AIAnalysisService.contract';
import { LLM_ANALYSIS_SERVICE_TOKEN } from '../../../../codeBase/llmAnalysis.service';

interface Parameters {
    parameter_instructions?: string | null;
    [key: string]: any;
}

interface ParsedParameters {
    parameter_instructions?: any; // The object after parsing
    [key: string]: any;
}

const toolDefinition = {
    tool_name: 'ConversationCodeBaseTool',
    tool_description:
        'Allows the user to interact with their codebase using a language model (LLM). The user can ask questions about the code, request detailed explanations, automatically generate documentation, receive guidance on how to perform specific tasks within the context of the code, and get help with completing specific work items or tasks related to the codebase.',
    tool_signals_to_choose:
        'Use this tool to get explanations about specific code functionalities, generate or update documentation, understand the workflow needed to implement new features, or for any need to comprehend the existing code. Also useful for providing guidance on completing tasks related to the codebase, such as delivering specific work items or fixing issues tied to code changes. Ideal for onboarding, code reviews, task completion, and maintaining documentation.',
    tool_parameters: {
        parameter_instructions: {
            parameter_instructions_example: [
                '{"query": "Explain the `calculateTotal` function in the `utils.js` file.", "operation": "explanation"}',
                '{"query": "Generate documentation for the `authentication` module.", "operation": "generate_documentation"}',
                '{"query": "What are the project dependencies and how are they used?", "operation": "list_dependencies"}',
                '{"query": "Suggest improvements for the `processOrder` function in the `orders.js` file.", "operation": "suggest_improvements"}',
            ],
            parameter_instructions_required: true,
            parameter_instructions_description:
                'An object containing the query or operation to be performed on the codebase. It should include the task description as a string and, optionally, the specific file or function targeted by the query.',
        },
    },
    tool_data_return_structure: {
        interactionResult: {
            stringResult: 'string',
            jsonResult: 'object',
        },
    },
};

@Injectable()
export class ConversationCodeBaseTool implements ITool<any, IToolResult> {
    constructor(
        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,

        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return ConversationCodeBaseTool.name;
    }

    get description(): string {
        return 'Allows the user to interact with their codebase using a language model (LLM). The user can ask questions about the code, request detailed explanations, automatically generate documentation, receive guidance on how to perform specific tasks within the context of the code, and get help with completing specific work items or tasks related to the codebase.';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const { organizationAndTeamData, message, sessionId } = context;
            const parameters = this.parseAndValidateParameters(
                input?.parameters,
            );

            const artifacts = input?.parameters?.GetArtifactsTool?.artifacts;
            const metrics = input?.parameters?.GetTeamMetricsTool?.metrics;
            const workItems = input?.parameters?.GetWorkItensTool?.weekTasks;
            const pullRequests =
                input?.parameters?.GetPullRequestsTool?.pullRequests;

            const messageWithData = `User Question: ${message} \n\n additional data: ${JSON.stringify(
                {
                    artifacts,
                    metrics,
                    workItems,
                    pullRequests,
                },
                null,
            )}`;

            const response =
                await this.aiAnalysisService.generateCodeSuggestions(
                    organizationAndTeamData,
                    sessionId,
                    messageWithData,
                    parameters,
                );

            return {
                stringResult: this.formatReturnToPrompt(response),
                jsonResult: response,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Conversation CodeBase Tool',
                context: ConversationCodeBaseTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing ConversationCodeBaseTool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(data: any) {
        return `Code Base data: ${JSON.stringify(data.message)}`;
    }

    private parseAndValidateParameters(
        parameters: Parameters | undefined | null,
    ): ParsedParameters | null {
        if (!parameters) {
            return null;
        }

        let parsedParameters: ParsedParameters = {};

        if (parameters?.parameter_instructions) {
            try {
                parsedParameters.parameter_instructions = JSON.parse(
                    parameters.parameter_instructions,
                );
            } catch (e) {
                parsedParameters.parameter_instructions = null;
            }
        }

        return parsedParameters;
    }
}
