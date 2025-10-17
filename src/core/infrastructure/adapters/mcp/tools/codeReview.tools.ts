import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    ICodeReviewFeedbackService,
    CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
} from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';

const CodeReviewFeedbackSchema = z
    .object({
        uuid: z.string(),
        suggestionId: z.string(),
        comment: z
            .object({
                id: z.number().optional(),
                pullRequestReviewId: z.string().optional(),
            })
            .optional(),
        pullRequest: z
            .object({
                id: z.string(),
                number: z.number(),
                repository: z.object({
                    id: z.string(),
                    fullName: z.string(),
                }),
            })
            .optional(),
        organizationId: z.string(),
        reactions: z
            .object({
                thumbsUp: z.number(),
                thumbsDown: z.number(),
            })
            .optional(),
        syncedEmbeddedSuggestions: z.boolean().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

interface CodeReviewFeedbacksResponse extends BaseResponse {
    data: z.infer<typeof CodeReviewFeedbackSchema>[];
}

interface CodeReviewFeedbackResponse extends BaseResponse {
    data: z.infer<typeof CodeReviewFeedbackSchema> | null;
}

@Injectable()
export class CodeReviewTools {
    constructor(
        @Inject(CODE_REVIEW_FEEDBACK_SERVICE_TOKEN)
        private readonly codeReviewFeedbackService: ICodeReviewFeedbackService,
        private readonly logger: PinoLoggerService,
    ) {}

    listCodeReviewFeedbacks(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to list all code review feedbacks',
                ),
            repositoryId: z
                .string()
                .optional()
                .describe(
                    'Repository ID - filter feedbacks by specific repository',
                ),
            syncedEmbeddedSuggestions: z
                .boolean()
                .optional()
                .describe(
                    'Filter by synced status - true for synced feedbacks, false for pending sync',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_CODE_REVIEW_FEEDBACKS',
            description:
                'List all code review feedbacks and suggestions provided by Kodus. Use this to see all suggestions made, track feedback history, or analyze code review patterns.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(CodeReviewFeedbackSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<CodeReviewFeedbacksResponse> => {
                    let feedbacks;

                    if (
                        args.repositoryId !== undefined &&
                        args.syncedEmbeddedSuggestions !== undefined
                    ) {
                        feedbacks =
                            await this.codeReviewFeedbackService.findByOrganizationAndSyncedFlag(
                                args.organizationId,
                                args.repositoryId,
                                args.syncedEmbeddedSuggestions,
                            );
                    } else {
                        feedbacks = await this.codeReviewFeedbackService.find({
                            organizationId: args.organizationId,
                        });
                    }

                    return {
                        success: true,
                        count: feedbacks?.length || 0,
                        data: feedbacks || [],
                    };
                },
                'list_code_review_feedbacks',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getCodeReviewFeedback(): McpToolDefinition {
        const inputSchema = z.object({
            feedbackId: z
                .string()
                .describe(
                    'Feedback UUID - unique identifier for the feedback to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_CODE_REVIEW_FEEDBACK',
            description:
                'Get detailed information about a specific code review feedback including the suggestion, comment details, and reactions. Use this to understand a specific review comment.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([CodeReviewFeedbackSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<CodeReviewFeedbackResponse> => {
                    const feedback =
                        await this.codeReviewFeedbackService.findById(
                            args.feedbackId,
                        );

                    return {
                        success: !!feedback,
                        count: feedback ? 1 : 0,
                        data: feedback || null,
                    };
                },
                'get_code_review_feedback',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    getCodeReviewFeedbacksByPullRequest(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization',
                ),
            pullRequestId: z
                .string()
                .describe('Pull Request UUID - filter by specific PR'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_CODE_REVIEW_FEEDBACKS_BY_PR',
            description:
                'Get all code review feedbacks for a specific pull request. Use this to see all suggestions and comments made on a PR, analyze PR feedback, or track review completeness.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(CodeReviewFeedbackSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<CodeReviewFeedbacksResponse> => {
                    const feedbacks =
                        await this.codeReviewFeedbackService.find({
                            organizationId: args.organizationId,
                            'pullRequest.id': args.pullRequestId,
                        });

                    return {
                        success: true,
                        count: feedbacks?.length || 0,
                        data: feedbacks || [],
                    };
                },
                'get_code_review_feedbacks_by_pr',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.listCodeReviewFeedbacks(),
            this.getCodeReviewFeedback(),
            this.getCodeReviewFeedbacksByPullRequest(),
        ];
    }
}

