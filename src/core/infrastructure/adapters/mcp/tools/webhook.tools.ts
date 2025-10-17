import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    IWebhookLogService,
    WEBHOOK_LOG_SERVICE_TOKEN,
} from '@/core/domain/webhookLog/contracts/webhook-log.service.contract';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

const WebhookLogSchema = z
    .object({
        uuid: z.string(),
        platform: z.nativeEnum(PlatformType),
        event: z.string(),
        payload: z.any(),
        meta: z.any().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

interface WebhookLogsResponse extends BaseResponse {
    data: z.infer<typeof WebhookLogSchema>[];
}

interface WebhookLogResponse extends BaseResponse {
    data: z.infer<typeof WebhookLogSchema> | null;
}

@Injectable()
export class WebhookTools {
    constructor(
        @Inject(WEBHOOK_LOG_SERVICE_TOKEN)
        private readonly webhookLogService: IWebhookLogService,
        private readonly logger: PinoLoggerService,
    ) {}

    listWebhookLogs(): McpToolDefinition {
        const inputSchema = z.object({
            platform: z
                .nativeEnum(PlatformType)
                .optional()
                .describe(
                    'Filter webhook logs by platform (GITHUB, GITLAB, AZURE_REPOS, BITBUCKET)',
                ),
            event: z
                .string()
                .optional()
                .describe(
                    'Filter webhook logs by event type (e.g., "pull_request", "push", "issue")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_WEBHOOK_LOGS',
            description:
                'List webhook logs received from code management platforms with optional filtering by platform or event type. Use this to debug webhooks, track platform events, or analyze integration activity.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(WebhookLogSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<WebhookLogsResponse> => {
                    const filter: any = {};
                    if (args.platform) filter.platform = args.platform;
                    if (args.event) filter.event = args.event;

                    const webhookLogs = await this.webhookLogService.find(
                        filter,
                    );

                    return {
                        success: true,
                        count: webhookLogs?.length || 0,
                        data: webhookLogs || [],
                    };
                },
                'list_webhook_logs',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getWebhookLog(): McpToolDefinition {
        const inputSchema = z.object({
            webhookLogId: z
                .string()
                .describe(
                    'Webhook Log UUID - unique identifier for the webhook log to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_WEBHOOK_LOG',
            description:
                'Get detailed information about a specific webhook log including platform, event type, full payload, and metadata. Use this to debug specific webhook calls or understand event details.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([WebhookLogSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<WebhookLogResponse> => {
                    const webhookLog = await this.webhookLogService.findOne({
                        uuid: args.webhookLogId,
                    });

                    return {
                        success: !!webhookLog,
                        count: webhookLog ? 1 : 0,
                        data: webhookLog || null,
                    };
                },
                'get_webhook_log',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    getWebhookLogsByPlatform(): McpToolDefinition {
        const inputSchema = z.object({
            platform: z
                .nativeEnum(PlatformType)
                .describe(
                    'Platform type to filter webhook logs (GITHUB, GITLAB, AZURE_REPOS, BITBUCKET)',
                ),
            limit: z
                .number()
                .optional()
                .default(50)
                .describe('Maximum number of logs to return (default: 50)'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_WEBHOOK_LOGS_BY_PLATFORM',
            description:
                'Get webhook logs from a specific platform with optional limit. Use this to see platform-specific activity, debug integration issues, or analyze platform event patterns.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(WebhookLogSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<WebhookLogsResponse> => {
                    const webhookLogs = await this.webhookLogService.find({
                        platform: args.platform,
                    });

                    // Apply limit
                    const limitedLogs = webhookLogs?.slice(0, args.limit) || [];

                    return {
                        success: true,
                        count: limitedLogs?.length || 0,
                        data: limitedLogs,
                    };
                },
                'get_webhook_logs_by_platform',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.listWebhookLogs(),
            this.getWebhookLog(),
            this.getWebhookLogsByPlatform(),
        ];
    }
}

