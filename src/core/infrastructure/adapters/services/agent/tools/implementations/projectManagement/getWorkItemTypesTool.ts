import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import { WorkItemType } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetWorkItemTypesTool',
    tool_description:
        'Retrieves a comprehensive list of work item types from project management tools, offering insights into the various categories of tasks, bugs, stories, and other items that can be tracked within projects. This tool is essential for understanding the range of work items that can be created and managed, facilitating project setup, item categorization, and workflow configuration.',
    tool_signals_to_choose:
        "Utilize this tool when you need to identify the different types of work items available for creation and management in your project management system. It's especially useful for initializing projects, crafting filters, or setting up boards and reporting mechanisms.",
    tool_parameters: {},
    tool_data_return_structure: {
        workItemTypes: [
            {
                id: 'string',
                name: 'string',
                subtask: 'boolean',
                description: 'string',
            },
        ],
    },
};

@Injectable()
export class GetWorkItemTypesTool implements ITool<any, IToolResult> {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetWorkItemTypesTool.name;
    }

    get description(): string {
        return 'Get all work item types on a board (e.g., bugs, tasks). Return this structure: [{"id": "string", "name": "string", "subtask": boolean, "description": "string"}, {"id": "string", "name": "string", "subtask": boolean, "description": "string"}]';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const workItemTypes =
                await this.projectManagementService.getWorkItemTypes({
                    organizationAndTeamData: context.organizationAndTeamData,
                });

            return {
                stringResult: this.formatReturnToPrompt(workItemTypes),
                jsonResult: workItemTypes,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Work Item Types Tool',
                context: GetWorkItemTypesTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Work Items Types Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(workItemTypes: WorkItemType[]): string {
        return `Work Item Types for this team: ${JSON.stringify(workItemTypes)}`;
    }
}
