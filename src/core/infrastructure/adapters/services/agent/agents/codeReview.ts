import { RunParams } from '@/config/types/general/agentRouter.type';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';

import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
    IToolExecutionService,
    TOOL_EXECUTION_SERVICE_TOKEN,
    ToolsExecutionResult,
} from '../tools/interfaces/IToolExecution.interface';

@Injectable()
export class CodeReviewAgentProvider implements IAgentRouterStrategy {
    name: 'CodeReviewAgent';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(TOOL_EXECUTION_SERVICE_TOKEN)
        private toolExecutionService: IToolExecutionService,
    ) {}

    async run(runParams: RunParams): Promise<any> {
        try {
            runParams.message = `Choose the code review tool, regardless of the user's question.

                1 - Choose GetPullRequestsTool
                2 - According to the values   of GetPullRequestsTool, move to CodeReviewTool
                3 - CodeReviewTool perform the review according to the result of GetPullRequestsTool

                filters:
                - PR STATUS: all
                - PR Data: 2 Month
            `;

            const resultTool = await this.runTools(runParams);

            const codeBaseResults = resultTool?.results?.find((result) =>
                result.includes('Code Base data'),
            );

            return { response: this.formatMarkdownContent(codeBaseResults) };
        } catch (error) {
            console.error(error);
            throw new Error('TaskInsights error', error);
        }
    }

    private formatMarkdownContent(input) {
        // Check if the input starts with 'Code Base data:'
        if (input?.startsWith('Code Base data:')) {
            // Remove 'Code Base data:' and any extra quotes around it
            const rawMarkdown = input.replace(/^Code Base data:\s*/, '').trim();

            // Remove double quotes at the beginning and end of the string, if they exist
            const cleanedMarkdown = rawMarkdown.replace(/^"(.*)"$/, '$1');

            // Replace '\\n' with actual line breaks and '\\' with nothing
            return cleanedMarkdown.replace(/\\n/g, '\n').replace(/\\\\/g, '');
        }

        // If it doesn't start with 'Code Base data:', return the input as is
        return input;
    }

    async runTools(runParams: RunParams): Promise<ToolsExecutionResult> {
        try {
            const toolDefinitions = this.toolExecutionService.findTools([
                'CodeReviewTool',
                'GetPullRequestsTool',
            ]);

            return await this.toolExecutionService.executeInvocationSequenceWithLLM(
                toolDefinitions,
                {
                    organizationAndTeamData: runParams.organizationAndTeamData,
                    message: runParams.message,
                    sessionId: runParams.sessionId,
                },
            );
        } catch (error) {
            console.log(error);
        }
    }
}
