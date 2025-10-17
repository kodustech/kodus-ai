import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@/core/domain/tokenUsage/contracts/tokenUsage.service.contract';

const DailyUsageSchema = z
    .object({
        date: z.string(),
        totalTokens: z.number(),
        totalCost: z.number(),
        totalRequests: z.number(),
        breakdownByModel: z.array(
            z.object({
                model: z.string(),
                tokens: z.number(),
                cost: z.number(),
                requests: z.number(),
            }),
        ),
    })
    .passthrough();

const UsageSummarySchema = z
    .object({
        totalTokens: z.number(),
        totalCost: z.number(),
        totalRequests: z.number(),
        averageTokensPerRequest: z.number(),
        mostUsedModel: z.string().optional(),
        breakdownByModel: z.array(
            z.object({
                model: z.string(),
                tokens: z.number(),
                cost: z.number(),
                requests: z.number(),
                percentage: z.number(),
            }),
        ),
    })
    .passthrough();

interface DailyUsageResponse extends BaseResponse {
    data: z.infer<typeof DailyUsageSchema>[];
}

interface UsageSummaryResponse extends BaseResponse {
    data: z.infer<typeof UsageSummarySchema>;
}

@Injectable()
export class UsageTools {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,
        private readonly logger: PinoLoggerService,
    ) {}

    getDailyUsage(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to get usage data',
                ),
            teamId: z
                .string()
                .optional()
                .describe(
                    'Team UUID - optional filter to get usage for specific team',
                ),
            startDate: z
                .string()
                .describe(
                    'Start date for usage query in ISO format (YYYY-MM-DD)',
                ),
            endDate: z
                .string()
                .describe('End date for usage query in ISO format (YYYY-MM-DD)'),
            model: z
                .string()
                .optional()
                .describe(
                    'Filter by specific AI model (e.g., "gpt-4", "claude-3")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_DAILY_USAGE',
            description:
                'Get daily token usage statistics broken down by date and model. Use this to track daily consumption, analyze usage patterns, or generate usage reports over a date range.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(DailyUsageSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<DailyUsageResponse> => {
                    const query: any = {
                        organizationId: args.organizationId,
                        startDate: new Date(args.startDate),
                        endDate: new Date(args.endDate),
                    };

                    if (args.teamId) query.teamId = args.teamId;
                    if (args.model) query.model = args.model;

                    const dailyUsage =
                        await this.tokenUsageService.getDailyUsage(query);

                    return {
                        success: true,
                        count: dailyUsage?.length || 0,
                        data: dailyUsage || [],
                    };
                },
                'get_daily_usage',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getUsageSummary(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to get usage summary',
                ),
            teamId: z
                .string()
                .optional()
                .describe(
                    'Team UUID - optional filter to get summary for specific team',
                ),
            startDate: z
                .string()
                .describe(
                    'Start date for summary period in ISO format (YYYY-MM-DD)',
                ),
            endDate: z
                .string()
                .describe(
                    'End date for summary period in ISO format (YYYY-MM-DD)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_USAGE_SUMMARY',
            description:
                'Get aggregated usage summary including total tokens, costs, requests, and breakdown by model. Use this for high-level usage overview, cost analysis, or billing reports.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: UsageSummarySchema,
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<UsageSummaryResponse> => {
                    const query: any = {
                        organizationId: args.organizationId,
                        startDate: new Date(args.startDate),
                        endDate: new Date(args.endDate),
                    };

                    if (args.teamId) query.teamId = args.teamId;

                    const summary =
                        await this.tokenUsageService.getSummary(query);

                    return {
                        success: true,
                        count: 1,
                        data: summary,
                    };
                },
                'get_usage_summary',
                () => ({
                    success: false,
                    count: 0,
                    data: {
                        totalTokens: 0,
                        totalCost: 0,
                        totalRequests: 0,
                        averageTokensPerRequest: 0,
                        breakdownByModel: [],
                    },
                }),
            ),
        };
    }

    getCurrentMonthUsage(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization',
                ),
            teamId: z
                .string()
                .optional()
                .describe('Team UUID - optional filter by team'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_CURRENT_MONTH_USAGE',
            description:
                'Get usage summary for the current month (from 1st to today). Use this for month-to-date usage tracking, budget monitoring, or quick current month overview.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: UsageSummarySchema,
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<UsageSummaryResponse> => {
                    const now = new Date();
                    const firstDayOfMonth = new Date(
                        now.getFullYear(),
                        now.getMonth(),
                        1,
                    );

                    const query: any = {
                        organizationId: args.organizationId,
                        startDate: firstDayOfMonth,
                        endDate: now,
                    };

                    if (args.teamId) query.teamId = args.teamId;

                    const summary =
                        await this.tokenUsageService.getSummary(query);

                    return {
                        success: true,
                        count: 1,
                        data: summary,
                    };
                },
                'get_current_month_usage',
                () => ({
                    success: false,
                    count: 0,
                    data: {
                        totalTokens: 0,
                        totalCost: 0,
                        totalRequests: 0,
                        averageTokensPerRequest: 0,
                        breakdownByModel: [],
                    },
                }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.getDailyUsage(),
            this.getUsageSummary(),
            this.getCurrentMonthUsage(),
        ];
    }
}

