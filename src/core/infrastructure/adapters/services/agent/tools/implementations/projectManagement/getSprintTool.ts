import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { ProjectManagementService } from '../../../../platformIntegration/projectManagement.service';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { PinoLoggerService } from '../../../../logger/pino.service';
import { ISprint } from '@/core/domain/platformIntegrations/interfaces/jiraSprint.interface';

const toolDefinition = {
    tool_name: 'GetSprintTool',
    tool_description:
        'Retrieves detailed information about sprints from the project management system. This tool provides insights into current and future work cycles, including dates, status, and associated work items. It is essential for sprint planning and tracking, facilitating agile project management.',
    tool_signals_to_choose:
        'Use this tool when you need to obtain information about specific or active sprints in your project management system. It is particularly useful for sprint planning, progress review, and organizing work in defined time cycles.',
    tool_parameters: {
        parameter_sprint_id: {
            parameter_sprint_id_example: 'SPRINT-123',
            parameter_sprint_id_required: false,
            parameter_sprint_id_description:
                'The specific sprint ID to be retrieved. If not provided, the active sprint will be returned.',
        },
        parameter_type: {
            parameter_type_example: 'current',
            parameter_type_required: false,
            parameter_type_description:
                'The type of sprint to be retrieved. It can be "current" for the current sprint or "all" for all sprints.',
        },
    },
    tool_data_return_structure: {
        sprint: {
            id: 'string',
            name: 'string',
            goal: 'string',
            startDate: 'string',
            endDate: 'string',
            status: 'string',
            issues: [
                {
                    id: 'string',
                    key: 'string',
                    summary: 'string',
                    status: 'string',
                    assignee: {
                        id: 'string',
                        name: 'string',
                        email: 'string',
                    },
                },
            ],
        },
    },
};

@Injectable()
export class GetSprintTool implements ITool<any, IToolResult> {
    constructor(
        private readonly projectManagementService: ProjectManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetSprintTool.name;
    }

    get description(): string {
        return 'Retrieves detailed information about a specific sprint or the current active sprint.';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const sprintId = input?.parameters?.parameter_sprint_id;
            const type = input?.parameters?.parameter_type;

            let sprints: ISprint[] = [];

            if (type === 'current') {
                sprints.push(
                    await this.projectManagementService.getCurrentSprintForTeam(
                        {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                        },
                    ),
                );
            } else {
                const allSprints =
                    await this.projectManagementService.getAllSprintsForTeam({
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    });

                if (sprintId) {
                    sprints.push(
                        allSprints.find((sprint) => sprint.id === sprintId),
                    );
                } else {
                    sprints.push(...allSprints);
                }
            }

            return {
                stringResult: this.formatReturnToPrompt(sprints),
                jsonResult: sprints,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Sprint Tool',
                context: GetSprintTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Sprint Tool. Please try again.',
                jsonResult: {},
            };
        }
    }

    private formatReturnToPrompt(sprints: ISprint[]): string {
        return `Sprint Information:\n${JSON.stringify(sprints, null, 2)}`;
    }
}
