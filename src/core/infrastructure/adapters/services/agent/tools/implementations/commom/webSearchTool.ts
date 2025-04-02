import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '../../../../logger/pino.service';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { tavily } from '@tavily/core';

const webSearchToolDefinition = {
    tool_name: 'WebSearchTool',
    tool_description:
        'Performs a web search and returns the most relevant and up-to-date results.',
    tool_signals_to_choose:
        'Use this tool whenever you need to gain a deeper understanding of a specific topic, lack knowledge about a subject, require a more accurate answer, or need the most recent information.',
    tool_parameters: {
        parameter_query: {
            parameter_query_example: 'What are the latest advancements in AI?',
            parameter_query_required: true,
            parameter_query_description:
                'A string representing the search query to be executed.',
        },
    },
    tool_data_return_structure: {
        response: 'string',
    },
};

@Injectable()
export class WebSearchTool implements ITool<any, IToolResult> {
    constructor(private readonly logger: PinoLoggerService) {}

    get name(): string {
        return WebSearchTool.name;
    }

    get description(): string {
        return 'Realize a search in the web and return the most relevant results.';
    }

    get definition(): object {
        return webSearchToolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

            const query = input?.parameters?.parameter_query;

            const response = await tvly.searchQNA(query, {
                maxResults: 10,
            });

            return {
                stringResult: response,
                jsonResult: { result: response },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Web Search Tool',
                context: WebSearchTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Web Search Tool. Please try again.',
                jsonResult: {},
            };
        }
    }

    private formatReturnToPrompt(results: any[]): string {
        return `Resultados da pesquisa:\n${JSON.stringify(results, null, 2)}`;
    }
}
