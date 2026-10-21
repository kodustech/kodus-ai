import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@libs/issues/domain/contracts/issues.service.contract';
import { IIssue } from '@libs/issues/domain/interfaces/issues.interface';

import { McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

@Injectable()
export class KodyIssuesTools {
    private readonly logger = createLogger(KodyIssuesTools.name);
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {}

    createKodyIssue(): McpToolDefinition {
        const name = 'KODUS_CREATE_KODY_ISSUE';
        const inputSchema = z.strictObject({
            organizationId: z.string().describe('Organization ID'),
            title: z.string(),
            description: z.string(),
            filePath: z.string(),
            language: z.string(),
            label: z.enum(LabelType),
            severity: z.enum(SeverityLevel),
            repository: z.strictObject({
                id: z.string(),
                platformType: z.enum(PlatformType),
            }),
            owner: z
                .strictObject({
                    gitId: z
                        .number()
                        .describe('userId of user from git provider'),
                    username: z
                        .string()
                        .describe('username of user from git provider'),
                })
                .optional()
                .describe('Details of pull request author'),
            reporter: z
                .strictObject({
                    gitId: z.number(),
                    username: z.string(),
                })
                .optional()
                .describe('Details of user who is creating this issue'),
            originalKodyCommentId: z
                .number()
                .describe(
                    'commentId of original Kody comment though which the discussion got started ',
                ),
            pullRequestNumber: z
                .number()
                .describe('Pull request number to make issue for'),
        });
        type InputType = z.infer<typeof inputSchema>;

        return {
            name: name,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                proactiveHint:
                    'the developer agrees the finding is real but out of scope for this PR — track it instead of losing it',
            },
            description: 'Create a new Kody Issue manually via MCP',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.looseObject({}),
            }),
            execute: wrapToolHandler(
                async (args: InputType) => {
                    const { organizationId, pullRequestNumber, repository } =
                        args;

                    if (
                        pullRequestNumber === null ||
                        pullRequestNumber === undefined ||
                        !repository?.id
                    ) {
                        this.logger.error({
                            context: KodyIssuesTools.name,
                            message:
                                "Couldn't find pullRequest number or repository to create an issue via MCP",
                            metadata: { organizationId },
                        });
                        return { success: false };
                    }

                    const reporterInput = args.reporter ?? {
                        gitId: 1,
                        username: 'Kody-MCP',
                    };

                    const pullRequest =
                        await this.pullRequestsService.findByNumberAndRepositoryId(
                            pullRequestNumber,
                            repository.id,
                            { organizationId },
                        );

                    if (!pullRequest) {
                        this.logger.error({
                            context: KodyIssuesTools.name,
                            message: `Couldn't found pullRequest #${pullRequestNumber}  to create an issue via mcp`,
                            metadata: { organizationId },
                        });
                        return { success: false };
                    }

                    const owner =
                        pullRequest?.user?.id && pullRequest?.user?.username
                            ? {
                                  gitId: pullRequest.user.id.toString(),
                                  username: pullRequest.user.username,
                              }
                            : undefined;

                    const now = new Date().toISOString();
                    const issueInstance: IIssue = {
                        organizationId,
                        title: args.title,
                        description: args.description,
                        filePath: args.filePath,
                        language: args.language,
                        label: args.label,
                        severity: args.severity,
                        status: IssueStatus.OPEN,
                        repository: {
                            full_name: pullRequest?.repository?.fullName,
                            id: pullRequest?.repository?.id,
                            name: pullRequest?.repository?.name,
                            platform: repository.platformType,
                        },
                        ...(owner && { owner }),
                        reporter: {
                            gitId: reporterInput.gitId?.toString() ?? '1',
                            username: reporterInput.username,
                        },
                        contributingSuggestions: [],
                        createdAt: now,
                        updatedAt: now,
                    };

                    const resolvedPrAuthor = args.owner
                        ? {
                              id: args.owner.gitId?.toString(),
                              name: args.owner.username,
                          }
                        : owner
                          ? {
                                id: owner.gitId,
                                name: owner.username,
                            }
                          : undefined;

                    const suggestionFromArgs =
                        typeof args.originalKodyCommentId !== 'undefined' &&
                        resolvedPrAuthor
                            ? {
                                  id: args.originalKodyCommentId.toString(),
                                  prNumber: pullRequest?.number,
                                  prAuthor: resolvedPrAuthor,
                              }
                            : undefined;

                    if (
                        suggestionFromArgs?.id &&
                        suggestionFromArgs.prNumber &&
                        suggestionFromArgs.prAuthor.id
                    ) {
                        issueInstance.contributingSuggestions.push(
                            suggestionFromArgs,
                        );
                    } else {
                        const suggestion = pullRequest.files
                            ?.flatMap((file) => file.suggestions ?? [])
                            .find(
                                (candidate) =>
                                    candidate.comment?.id ===
                                        args.originalKodyCommentId &&
                                    candidate.deliveryStatus ===
                                        DeliveryStatus.SENT,
                            );

                        if (suggestion?.id && resolvedPrAuthor) {
                            issueInstance.contributingSuggestions.push({
                                id: suggestion.id,
                                prNumber: pullRequest.number,
                                prAuthor: resolvedPrAuthor,
                            });
                        } else {
                            this.logger.error({
                                context: KodyIssuesTools.name,
                                message: `Couldn't found the related suggestionCommentId, skipping to connect issue with suggestion.`,
                                metadata: { organizationId },
                            });
                        }
                    }

                    const issue =
                        await this.issuesService.create(issueInstance);
                    return { success: true, data: issue };
                },
                name,
                undefined,
                this.logger,
            ),
        };
    }

    listKodyIssues(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z.string(),
            repositoryName: z.string().optional(),
            severity: z.enum(SeverityLevel).optional(),
            label: z.enum(LabelType).optional(),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_KODY_ISSUES',
            annotations: {
                readOnlyHint: true,
            },
            description: 'List Kody Issues with optional filters',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(z.looseObject({})),
            }),
            execute: wrapToolHandler(async (args: InputType) => {
                // The input says `repositoryName`; documents store it as
                // `repository.name`. Passing args straight through matched
                // nothing and forced a collection scan on every call.
                const { repositoryName, ...rest } = args;
                const issues = await this.issuesService.findByFilters({
                    ...rest,
                    ...(repositoryName && {
                        'repository.name': repositoryName,
                    }),
                } as Partial<IIssue>);
                return {
                    success: true,
                    count: issues.length,
                    data: issues,
                };
            }),
        };
    }

    getKodyIssueDetails(): McpToolDefinition {
        const inputSchema = z.object({
            // Filled from the caller's credential by McpToolAuthorizer.
            organizationId: z.string().optional(),
            issueId: z.string(),
        });
        type InputType = z.infer<typeof inputSchema>;
        return {
            name: 'KODUS_GET_KODY_ISSUE_DETAILS',
            annotations: {
                readOnlyHint: true,
            },
            description: 'Get a Kody Issue by id',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.looseObject({}).nullable(),
            }),
            execute: wrapToolHandler(async (args: InputType) => {
                const issue = args.organizationId
                    ? await this.findOwnIssue(args.issueId, args.organizationId)
                    : null;
                return {
                    success: !!issue,
                    data: issue,
                };
            }),
        };
    }

    updateKodyIssueStatus(): McpToolDefinition {
        const inputSchema = z.object({
            // Filled from the caller's credential by McpToolAuthorizer.
            organizationId: z.string().optional(),
            issueId: z.string(),
            status: z.enum(IssueStatus),
        });
        type InputType = z.infer<typeof inputSchema>;
        return {
            name: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                proactiveHint:
                    'the developer says a tracked issue is already fixed or no longer relevant',
            },
            description: 'Update issue status',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.looseObject({}).nullable(),
            }),
            execute: wrapToolHandler(async (args: InputType) => {
                if (
                    !args.organizationId ||
                    !(await this.ownsIssue(args.issueId, args.organizationId))
                ) {
                    return { success: false, data: null };
                }
                const updated = await this.issuesService.updateStatus(
                    args.issueId,
                    args.status,
                );
                return {
                    success: !!updated,
                    data: updated,
                };
            }),
        };
    }

    updateKodyIssueCategory(): McpToolDefinition {
        const inputSchema = z.object({
            // Filled from the caller's credential by McpToolAuthorizer.
            organizationId: z.string().optional(),
            issueId: z.string(),
            label: z.enum(LabelType),
        });
        type InputType = z.infer<typeof inputSchema>;
        return {
            name: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                proactiveHint:
                    'the developer says a finding is filed under the wrong category',
            },
            description: 'Update issue category/label',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.looseObject({}).nullable(),
            }),
            execute: wrapToolHandler(async (args: InputType) => {
                if (
                    !args.organizationId ||
                    !(await this.ownsIssue(args.issueId, args.organizationId))
                ) {
                    return { success: false, data: null };
                }
                const updated = await this.issuesService.updateLabel(
                    args.issueId,
                    args.label,
                );
                return {
                    success: !!updated,
                    data: updated,
                };
            }),
        };
    }

    deleteKodyIssue(): McpToolDefinition {
        const inputSchema = z.object({
            // Filled from the caller's credential by McpToolAuthorizer.
            organizationId: z.string().optional(),
            issueId: z.string(),
        });
        type InputType = z.infer<typeof inputSchema>;
        return {
            name: 'KODUS_DELETE_KODY_ISSUE',
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
            },
            description: 'Close/dismiss an issue',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.looseObject({}).nullable(),
            }),
            execute: wrapToolHandler(async (args: InputType) => {
                if (
                    !args.organizationId ||
                    !(await this.ownsIssue(args.issueId, args.organizationId))
                ) {
                    return { success: false, data: null };
                }
                const updated = await this.issuesService.updateStatus(
                    args.issueId,
                    IssueStatus.DISMISSED,
                );
                return {
                    success: !!updated,
                    data: updated,
                };
            }),
        };
    }

    // Issues are addressed by their Mongo _id (the update methods use
    // findByIdAndUpdate), and an issue of another organization answers like a
    // missing one. Do not filter with findOne({ uuid }): the schema has no
    // uuid field, so that lookup never matches. An absent organizationId never
    // reaches here (McpToolAuthorizer sets it); callers narrow it first, and
    // the check below keeps an empty value from widening the lookup.
    private async findOwnIssue(
        issueId: string,
        organizationId: string,
    ): Promise<IIssue | null> {
        if (!organizationId) return null;
        let issue: IIssue | null;
        try {
            issue = await this.issuesService.findById(issueId);
        } catch {
            return null; // malformed id
        }
        return issue?.organizationId === organizationId ? issue : null;
    }

    private async ownsIssue(
        issueId: string,
        organizationId: string,
    ): Promise<boolean> {
        return !!(await this.findOwnIssue(issueId, organizationId));
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.createKodyIssue(),
            this.listKodyIssues(),
            this.getKodyIssueDetails(),
            this.updateKodyIssueStatus(),
            this.updateKodyIssueCategory(),
            this.deleteKodyIssue(),
        ];
    }
}
