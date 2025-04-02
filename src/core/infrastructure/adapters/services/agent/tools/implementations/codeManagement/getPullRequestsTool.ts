import { Injectable } from '@nestjs/common';
import { ITool, ToolExecutionContext } from '../../interfaces/ITool.interface';
import { IToolResult } from '@/core/domain/agents/interfaces/toolResult.interface';
import { PullRequests } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { CodeManagementService } from '../../../../platformIntegration/codeManagement.service';
import { STRING_TIME_INTERVAL } from '@/core/domain/integrationConfigs/enums/stringTimeInterval.enum';
import * as moment from 'moment-timezone';
import { PinoLoggerService } from '../../../../logger/pino.service';

const toolDefinition = {
    tool_name: 'GetPullRequestsTool',
    tool_description:
        'Retrieves detailed information about pull requests from a version control repository. This includes data such as the pull request author, message, creation date, review status, and related work items. Use this tool to understand recent code contributions by specific developers or to track the work done by individual team members.',
    tool_signals_to_choose:
        'Use this tool when you need to gather information on: (1) Recent team member activities, particularly involving code contributions. (2) The status and history of code reviews, including the state of pull requests (open, closed, merged). (3) Changes in the codebase, whether for auditing or tracking purposes. (4) Specific contributions made by developers or teams. (5) Any situation requiring a detailed view of modifications to the source code through pull requests.',
    tool_parameters: {
        parameter_timeFilter: {
            parameter_timeFilter_example:
                '-12h | -24h | -48h | -72h | -7d | -14d | -1M | -2M | -3M',
            parameter_timeFilter_required: false,
            parameter_timeFilter_enum: [
                '-12h',
                '-24h',
                '-48h',
                '-72h',
                '-7d',
                '-14d',
                '-1M',
                '-2M',
                '-3M',
            ],
            parameter_timeFilter_description:
                'Type of time filter, one of the enums.',
        },
        parameter_assigneeFilter: {
            parameter_assigneeFilter_required: false,
            parameter_assigneeFilter_description:
                'Filter pull requests by the assignee. Provide an array of names or email addresses of the people responsible for the tasks.',
            parameter_assigneeFilter_example:
                '["John Doe", "jane.doe@example.com"]',
        },
        parameter_state: {
            parameter_state_required: false,
            parameter_state_description: 'Filter pull requests by state.',
            parameter_state_enum: ['all', 'open', 'closed'],
            parameter_state_example: 'all',
        },
        parameter_includeChanges: {
            parameter_includeChanges_required: false,
            parameter_includeChanges_description:
                'Include the changes associated with the pull requests. If set to true, the tool will retrieve the list of files changed and the diffs.',
            parameter_includeChanges_example: 'true',
        },
        parameter_pullRequestNumber: {
            parameter_pullRequestNumber_required: false,
            parameter_pullRequestNumber_description:
                'Retrieve specific pull request(s) by their number(s). Provide a single number or an array of numbers. If not provided, all pull requests matching other filters will be retrieved.',
            parameter_pullRequestNumber_example: '[12345, 67890] or [8793]',
        },
    },
    tool_data_return_structure: {
        pullRequests: [
            {
                id: 'string',
                repository: 'string',
                pull_number: 'number',
                author_id: 'string',
                author_name: 'string',
                author_created_at: 'string',
                message: 'string',
                state: 'string',
                changes: [
                    {
                        filename: 'string',
                        additions: 'number',
                        deletions: 'number',
                        changes: 'number',
                        patch: 'string',
                    },
                ],
            },
        ],
    },
};

@Injectable()
export class GetPullRequestsTool implements ITool<any, IToolResult> {
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private logger: PinoLoggerService,
    ) {}

    get name(): string {
        return GetPullRequestsTool.name;
    }

    get description(): string {
        return 'Retrieve all pull requests within a specified date range from a version control repository. Return this structure: [{"id": "string", "author_id": "string", "author_name": "string", "author_created_at": "string", "message": "string"}]';
    }

    get definition(): object {
        return toolDefinition;
    }

    async execute(
        input: any,
        context: ToolExecutionContext,
    ): Promise<IToolResult> {
        try {
            const hasConnection =
                await this.codeManagementService.verifyConnection({
                    organizationAndTeamData: context.organizationAndTeamData,
                });

            if (!hasConnection) {
                return {
                    stringResult:
                        'Team does not have configuration with any source code tool',
                    jsonResult: {},
                };
            }

            let filters: any = {};
            const timeFilter = input?.parameters?.parameter_timeFilter;
            const assignFilter = input?.parameters?.parameter_assigneeFilter;
            const stateFilter = input?.parameters?.parameter_state;
            const includeChanges = input?.parameters?.parameter_includeChanges;
            let pullRequestNumbers = [];
            let startDate, endDate;

            if (input?.parameters?.parameter_pullRequestNumber) {
                try {
                    const parsedNumbers = JSON.parse(
                        input.parameters.parameter_pullRequestNumber,
                    );
                    if (Array.isArray(parsedNumbers)) {
                        pullRequestNumbers = parsedNumbers;
                    }
                } catch (error) {
                    this.logger.warn({
                        message:
                            'Invalid format for pull request number, ignoring parameter.',
                        context: GetPullRequestsTool.name,
                    });
                }
            }

            if (timeFilter) {
                const dateRange =
                    this.getDateRangeByEnumStringTimeInterval(timeFilter);
                startDate = dateRange.startDate;
                endDate = dateRange.endDate;
            }

            filters = {
                ...(startDate && { startDate }),
                ...(endDate && { endDate }),
                assignFilter:
                    assignFilter ??
                    (typeof assignFilter === 'string'
                        ? JSON.parse(assignFilter)
                        : undefined),
                state: stateFilter,
                includeChanges: includeChanges ?? false,
                pullRequestNumbers: pullRequestNumbers,
            };

            const pullRequests =
                await this.codeManagementService.getPullRequests({
                    organizationAndTeamData: context.organizationAndTeamData,
                    filters,
                });

            return {
                stringResult: this.formatReturnToPrompt(pullRequests),
                jsonResult: { pullRequests },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error executing Get Pull Request Tool',
                context: GetPullRequestsTool.name,
                error: error,
                metadata: {
                    teamId: context.organizationAndTeamData.teamId,
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                },
            });
            return {
                stringResult:
                    'Error executing Get Pull Request Tool. Please try again.',
                jsonResult: [],
            };
        }
    }

    private formatReturnToPrompt(pullRequests: PullRequests[]): string {
        return `Pull Requests:\n${JSON.stringify(pullRequests)}`;
    }

    private getDateRangeByEnumStringTimeInterval(
        intervalEnum: STRING_TIME_INTERVAL,
    ) {
        const today = new Date();

        const startDate = this.adjustDateByInterval(
            intervalEnum,
            new Date(today),
        );

        return {
            startDate: moment(startDate).format('YYYY-MM-DD HH:mm'),
            endDate: moment(today).format('YYYY-MM-DD HH:mm'),
        };
    }

    private adjustDateByInterval(
        interval: STRING_TIME_INTERVAL,
        date: Date,
    ): Date {
        const value = parseInt(interval.slice(1, -1));
        const unit = interval.slice(-1);

        switch (unit) {
            case 'h':
                date.setHours(date.getHours() - value);
                break;
            case 'd':
                date.setDate(date.getDate() - value);
                break;
            case 'M':
                date.setMonth(date.getMonth() - value);
                break;
            default:
                date.setDate(date.getDate() - 7);
        }

        return date;
    }
}
