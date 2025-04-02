import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { Epic } from '@/core/domain/platformIntegrations/types/projectManagement/epic.type';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetEpicsTool',
    tool_description:
        'Retrieves a comprehensive list of epics (also known as initiatives or objectives) and their linked work items from project management tools. This tool provides insights into high-level work items that represent large bodies of work and their associated tasks. It is essential for understanding the major objectives, their progress, and the detailed tasks involved, facilitating project planning, tracking, and management of large tasks and their linked items.',
    tool_signals_to_choose:
        "Utilize this tool when you need to identify and manage epics and their associated work items within your project management system. It's particularly useful for high-level project planning, creating roadmaps, and organizing work into major deliverables with their linked tasks.",
    tool_parameters: {},
    tool_data_return_structure: {
        epics: [
            {
                id: 'string',
                key: 'string',
                name: 'string',
                status: {
                    name: 'string',
                    id: 'string',
                    statusCategory: {
                        name: 'string',
                        id: 'number',
                    },
                },
                issues: [
                    {
                        id: 'string',
                        key: 'string',
                        name: 'string',
                        description: 'string',
                        workItemCreatedAt: 'string',
                        columnName: 'string',
                        priority: 'string',
                        flagged: 'boolean',
                        assignee: {
                            accountId: 'string',
                            userEmail: 'string',
                            userName: 'string',
                        },
                        workItemType: {
                            name: 'string',
                            id: 'string',
                            description: 'string',
                            subtask: 'boolean',
                        },
                        status: {
                            name: 'string',
                            id: 'string',
                            statusCategory: {
                                name: 'string',
                                id: 'number',
                            },
                            lastChangedDate: 'string',
                        },
                    },
                ],
            },
        ],
    },
};

@Injectable()
export class GetEpicsTool implements ITool<any, IToolResult> {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetEpicsTool.name;
    }

    get description(): string {
        return 'Get all epics (initiatives or objectives) and their linked work items on a board. Return this structure: [{"id": "string", "key": "string", "name": "string", "status": {"name": "string", "id": "string", "statusCategory": {"name": "string", "id": "number"}}, "issues": [{"id": "string", "key": "string", "name": "string", "description": "string", "workItemCreatedAt": "string", "columnName": "string", "priority": "string", "flagged": "boolean", "assignee": {"accountId": "string", "userEmail": "string", "userName": "string"}, "workItemType": {"name": "string", "id": "string", "description": "string", "subtask": "boolean"}, "status": {"name": "string", "id": "string", "statusCategory": {"name": "string", "id": "number"}, "lastChangedDate": "string"}}]}]';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const epics =
                await this.projectManagementService.getEpicsAndLinkedItems({
                    organizationAndTeamData: context.organizationAndTeamData,
                });

            return {
                stringResult: this.formatReturnToPrompt(epics),
                jsonResult: epics,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing GetEpics Tool',
                context: GetEpicsTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Epics Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(epics: Epic[]): string {
        const formattedEpics = epics
            .map((epic) => {
                const formattedIssues = epic.issues
                    .map(
                        (issue) => `
                - Issue Key: ${issue.key}
                - Name: ${issue.name}
                - Description: ${issue.description || 'No description'}
                - Created At: ${issue.workItemCreatedAt}
                - Column: ${issue.columnName}
                - Priority: ${issue.priority}
                - Flagged: ${issue.flagged}
                - Assignee: ${issue.assignee ? issue.assignee.userName : 'Unassigned'}
                - Work Item Type: ${issue.workItemType.name}
                - Status: ${issue.status.name}
                - Last Changed: ${issue.status.lastChangedDate}
            `,
                    )
                    .join('\n');

                return `
            Epic Key: ${epic.key}
            Name: ${epic.name}
            Status: ${epic.status.name}
            Issues:
            ${formattedIssues}
            `;
            })
            .join('\n\n');

        return `Epics (Initiatives) for this team:\n${formattedEpics}`;
    }
}
