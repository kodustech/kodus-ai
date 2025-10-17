import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    IAutomationService,
    AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/automation.service';
import {
    IAutomationExecutionService,
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/automation-execution.service';

const AutomationSchema = z
    .object({
        uuid: z.string(),
        name: z.string(),
        description: z.string().optional(),
        type: z.string(),
        enabled: z.boolean(),
        triggers: z.array(z.any()).optional(),
        actions: z.array(z.any()).optional(),
        organizationId: z.string(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

const AutomationExecutionSchema = z
    .object({
        uuid: z.string(),
        automationId: z.string().optional(),
        teamAutomationId: z.string().optional(),
        status: z.string(),
        dataExecution: z.any().optional(),
        errorMessage: z.string().optional(),
        startedAt: z.date().optional(),
        completedAt: z.date().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

interface AutomationsResponse extends BaseResponse {
    data: z.infer<typeof AutomationSchema>[];
}

interface AutomationResponse extends BaseResponse {
    data: z.infer<typeof AutomationSchema> | null;
}

interface AutomationExecutionsResponse extends BaseResponse {
    data: z.infer<typeof AutomationExecutionSchema>[];
}

interface PullRequestExecutionsResponse extends BaseResponse {
    data: z.infer<typeof AutomationExecutionSchema>[];
    total: number;
}

@Injectable()
export class AutomationTools {
    constructor(
        @Inject(AUTOMATION_SERVICE_TOKEN)
        private readonly automationService: IAutomationService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        private readonly logger: PinoLoggerService,
    ) {}

    listAutomations(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system to list all automations',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_AUTOMATIONS',
            description:
                'List all automations configured for an organization. Use this to see available automations, check automation settings, or discover what automated processes are configured.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(AutomationSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<AutomationsResponse> => {
                    const automations = await this.automationService.find({
                        organization: { uuid: args.organizationId },
                    });

                    return {
                        success: true,
                        count: automations?.length || 0,
                        data: automations || [],
                    };
                },
                'list_automations',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getAutomation(): McpToolDefinition {
        const inputSchema = z.object({
            automationId: z
                .string()
                .describe(
                    'Automation UUID - unique identifier for the automation to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_AUTOMATION',
            description:
                'Get detailed information about a specific automation including its triggers, actions, and configuration. Use this to understand how an automation works.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([AutomationSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<AutomationResponse> => {
                    const automation =
                        await this.automationService.findById(
                            args.automationId,
                        );

                    return {
                        success: !!automation,
                        count: automation ? 1 : 0,
                        data: automation || null,
                    };
                },
                'get_automation',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    listAutomationExecutions(): McpToolDefinition {
        const inputSchema = z.object({
            automationId: z
                .string()
                .optional()
                .describe(
                    'Automation UUID - filter executions by specific automation',
                ),
            teamAutomationId: z
                .string()
                .optional()
                .describe(
                    'Team Automation UUID - filter executions by team automation',
                ),
            status: z
                .string()
                .optional()
                .describe(
                    'Execution status filter (e.g., "pending", "running", "completed", "failed")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_AUTOMATION_EXECUTIONS',
            description:
                'List automation execution history with optional filtering by automation, team, or status. Use this to track automation runs, debug failures, or analyze execution patterns.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(AutomationExecutionSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<AutomationExecutionsResponse> => {
                    const filter: any = {};
                    if (args.automationId)
                        filter.automation = { uuid: args.automationId };
                    if (args.teamAutomationId)
                        filter.teamAutomation = { uuid: args.teamAutomationId };
                    if (args.status) filter.status = args.status;

                    const executions =
                        await this.automationExecutionService.find(filter);

                    return {
                        success: true,
                        count: executions?.length || 0,
                        data: executions || [],
                    };
                },
                'list_automation_executions',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getPullRequestExecutions(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization',
                ),
            repositoryIds: z
                .array(z.string())
                .optional()
                .describe('Filter by specific repository IDs'),
            skip: z
                .number()
                .optional()
                .default(0)
                .describe('Number of records to skip for pagination'),
            take: z
                .number()
                .optional()
                .default(50)
                .describe('Number of records to take (max 100)'),
            order: z
                .enum(['ASC', 'DESC'])
                .optional()
                .default('DESC')
                .describe('Sort order by creation date'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_PULL_REQUEST_EXECUTIONS',
            description:
                'Get automation executions specifically for pull requests with pagination. Use this to see code review automation history, analyze review patterns, or track PR automation performance.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                total: z.number(),
                data: z.array(AutomationExecutionSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<PullRequestExecutionsResponse> => {
                    const result =
                        await this.automationExecutionService.findPullRequestExecutionsByOrganization(
                            {
                                organizationId: args.organizationId,
                                repositoryIds: args.repositoryIds,
                                skip: args.skip,
                                take: Math.min(args.take, 100),
                                order: args.order,
                            },
                        );

                    return {
                        success: true,
                        count: result.data?.length || 0,
                        total: result.total || 0,
                        data: result.data || [],
                    };
                },
                'get_pull_request_executions',
                () => ({ success: false, count: 0, total: 0, data: [] }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.listAutomations(),
            this.getAutomation(),
            this.listAutomationExecutions(),
            this.getPullRequestExecutions(),
        ];
    }
}

