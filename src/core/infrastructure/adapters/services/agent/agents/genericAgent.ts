import { RunParams } from '@/config/types/general/agentRouter.type';
import {
    IMemoryService,
    MEMORY_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/memory.service';

import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { Inject, Injectable } from '@nestjs/common';

import { conversationChatMemory } from '@/shared/utils/langchainCommon/conversationChatMemory';

import { PromptService } from '../../prompt.service';
import { getCurrentDateTimezone } from '@/shared/utils/transforms/date';

import {
    IToolExecutionService,
    TOOL_EXECUTION_SERVICE_TOKEN,
    ToolsExecutionResult,
} from '../tools/interfaces/IToolExecution.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';

@Injectable()
export class GenericQueryAgentProvider implements IAgentRouterStrategy {
    name: 'genericQuery';

    constructor(
        @Inject(MEMORY_SERVICE_TOKEN)
        private readonly memoryService: IMemoryService,

        @Inject(TOOL_EXECUTION_SERVICE_TOKEN)
        private toolExecutionService: IToolExecutionService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,

        private readonly promptService: PromptService,
    ) {}

    async run(runParams: RunParams): Promise<any> {
        try {
            const organizationAndTeamData = runParams.organizationAndTeamData;

            const promptContext =
                await this.promptService.getCompleteContextPromptByName(
                    'prompt_genericAgent',
                    {
                        organizationAndTeamData,
                    },
                );

            const resultTool = await this.runTools(runParams);

            const timezone = (
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.TIMEZONE_CONFIG,
                    organizationAndTeamData,
                )
            )?.configValue;

            runParams.message =
                runParams.message +
                `\n Contextual information (dont need to respond today date to user): Today Date and Hour:${getCurrentDateTimezone(timezone)}
                \n\n ${resultTool?.results?.map((result) => result)}\n`;

            const collection = this.memoryService.getNativeCollection();

            const response = await conversationChatMemory(
                collection,
                promptContext,
                runParams,
                {
                    module: 'GenericQueryAgent',
                    teamId: runParams.organizationAndTeamData.teamId,
                    nameOfToolsExecuted: resultTool?.nameOfToolsExecuted,
                    sessionId: runParams?.sessionId,
                },
                {
                    model: getLLMModelProviderWithFallback(
                        LLMModelProvider.CHATGPT_4_ALL,
                    ),
                },
            );

            return response;
        } catch (error) {
            console.error(error);
            throw new Error('TaskInsights error', error);
        }
    }

    async runTools(runParams: RunParams): Promise<ToolsExecutionResult> {
        try {
            const toolDefinitions = this.toolExecutionService.findTools([
                'GetColumnsConfigTool',
                'GetWorkItensTool',
                'GetTeamMetricsTool',
                'GetDeliveryEstimationForWorkItemsTool',
                'GetArtifactsTool',
                'GetWorkItemTypesTool',
                'GetWorkItemsDeliveryStatusTool',
                'GetEpicsTool',
                'GetPullRequestsTool',
                'CodeExecutionTool',
                'DataAnalysisTool',
                'ConversationCodeBaseTool',
                'CodeReviewTool',
                'WebSearchTool',
                'GetSprintTool',
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
