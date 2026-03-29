import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GithubIssuesService } from '@libs/platform/infrastructure/adapters/services/github/github-issues.service';

import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

const GitHubIssueSchema = z.strictObject({
    id: z.number(),
    nodeId: z.string(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    locked: z.boolean(),
    htmlUrl: z.string(),
    comments: z.number(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    user: z
        .strictObject({
            login: z.string(),
            id: z.number(),
            avatarUrl: z.string().optional(),
            htmlUrl: z.string().optional(),
        })
        .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    closedAt: z.string().nullable(),
});

interface ListGitHubIssuesResponse extends BaseResponse {
    data: z.infer<typeof GitHubIssueSchema>[];
}

interface GetGitHubIssueResponse extends BaseResponse {
    data: z.infer<typeof GitHubIssueSchema> | null;
}

@Injectable()
export class GithubIssuesTools {
    constructor(private readonly githubIssuesService: GithubIssuesService) {}

    listGithubIssues(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z.string(),
            teamId: z.string(),
            repository: z.strictObject({
                owner: z.string(),
                name: z.string(),
            }),
            filters: z
                .strictObject({
                    state: z.enum(['open', 'closed', 'all']).optional(),
                    labels: z.array(z.string()).optional(),
                    assignee: z.string().optional(),
                    creator: z.string().optional(),
                    since: z.string().optional(),
                    sort: z.enum(['created', 'updated', 'comments']).optional(),
                    direction: z.enum(['asc', 'desc']).optional(),
                    page: z.number().int().positive().optional(),
                    perPage: z.number().int().positive().max(100).optional(),
                })
                .optional(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_GITHUB_ISSUES',
            description:
                'List GitHub repository issues using the team GitHub integration credentials.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(GitHubIssueSchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<ListGitHubIssuesResponse> => {
                    const issues = await this.githubIssuesService.listIssues({
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
                'KODUS_LIST_GITHUB_ISSUES',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getGithubIssue(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z.string(),
            teamId: z.string(),
            repository: z.strictObject({
                owner: z.string(),
                name: z.string(),
            }),
            issueNumber: z.number().int().positive(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_GITHUB_ISSUE',
            description:
                'Get a single GitHub repository issue by issue number using team integration credentials.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: GitHubIssueSchema.nullable(),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<GetGitHubIssueResponse> => {
                    const issue = await this.githubIssuesService.getIssue({
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
                'KODUS_GET_GITHUB_ISSUE',
                () => ({ success: false, data: null }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [this.listGithubIssues(), this.getGithubIssue()];
    }
}
