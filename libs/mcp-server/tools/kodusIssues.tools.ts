import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

const IssueSchema = z.strictObject({
    id: z.string(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    url: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    author: z
        .strictObject({
            username: z.string(),
            id: z.string().optional(),
        })
        .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    closedAt: z.string().nullable(),
    platform: z.string(),
});

const repositorySchema = z.strictObject({
    owner: z.string(),
    name: z.string(),
});

interface ListIssuesResponse extends BaseResponse {
    data: z.infer<typeof IssueSchema>[];
}

interface GetIssueResponse extends BaseResponse {
    data: z.infer<typeof IssueSchema> | null;
}

/**
 * Provider-agnostic issue tools. The host (GitHub / GitLab / Bitbucket /
 * Forgejo) is resolved from the team's connected code-management integration;
 * the agent passes `owner`/`name` and reads issues to verify a PR against its
 * issue.
 */
@Injectable()
export class KodusIssuesTools {
    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    listIssues(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z.string(),
            teamId: z.string(),
            repository: repositorySchema,
            filters: z
                .strictObject({
                    state: z.enum(['open', 'closed', 'all']).optional(),
                    labels: z.array(z.string()).optional(),
                    assignee: z.string().optional(),
                    since: z.string().optional(),
                    page: z.number().int().positive().optional(),
                    perPage: z.number().int().positive().max(100).optional(),
                })
                .optional(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_ISSUES',
            description:
                "List issues from the repository's issue tracker (GitHub, GitLab, Bitbucket, or Forgejo) using the team's code-management integration.",
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(IssueSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<ListIssuesResponse> => {
                    const issues =
                        await this.codeManagementService.listIssues({
                            organizationAndTeamData: {
                                organizationId: args.organizationId,
                                teamId: args.teamId,
                            },
                            repository: args.repository,
                            filters: args.filters,
                        });

                    return {
                        success: true,
                        count: issues.length,
                        data: issues,
                    };
                },
                'KODUS_LIST_ISSUES',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getIssue(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z.string(),
            teamId: z.string(),
            repository: repositorySchema,
            issueNumber: z.number().int().positive(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_ISSUE',
            description:
                "Get a single issue by number from the repository's issue tracker using the team's code-management integration.",
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: IssueSchema.nullable(),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<GetIssueResponse> => {
                    const issue = await this.codeManagementService.getIssue({
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: args.repository,
                        issueNumber: args.issueNumber,
                    });

                    return {
                        success: true,
                        data: issue,
                    };
                },
                'KODUS_GET_ISSUE',
                () => ({ success: false, data: null }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [this.listIssues(), this.getIssue()];
    }
}
