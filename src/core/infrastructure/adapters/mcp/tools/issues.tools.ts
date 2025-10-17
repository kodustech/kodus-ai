import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { PinoLoggerService } from '../../services/logger/pino.service';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';
import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@/core/domain/issues/contracts/issues.service.contract';
import { IssueStatus } from '@/config/types/general/issues.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { LabelType } from '@/shared/utils/codeManagement/labels';

const IssueSchema = z
    .object({
        uuid: z.string(),
        title: z.string(),
        description: z.string().optional(),
        status: z.nativeEnum(IssueStatus),
        severity: z.nativeEnum(SeverityLevel).optional(),
        label: z.string().optional(),
        organizationId: z.string(),
        repositoryId: z.string(),
        filePath: z.string().optional(),
        lineNumber: z.number().optional(),
        suggestionIds: z.array(z.string()).optional(),
        metadata: z.any().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
    })
    .passthrough();

interface IssuesResponse extends BaseResponse {
    data: z.infer<typeof IssueSchema>[];
}

interface IssueResponse extends BaseResponse {
    data: z.infer<typeof IssueSchema> | null;
}

interface IssuesCountResponse extends BaseResponse {
    data: {
        count: number;
    };
}

@Injectable()
export class IssuesTools {
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,
        private readonly logger: PinoLoggerService,
    ) {}

    listIssues(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization to list all issues',
                ),
            repositoryId: z
                .string()
                .optional()
                .describe('Filter issues by specific repository'),
            status: z
                .nativeEnum(IssueStatus)
                .optional()
                .describe(
                    'Filter issues by status (open, in_progress, resolved, closed)',
                ),
            severity: z
                .nativeEnum(SeverityLevel)
                .optional()
                .describe(
                    'Filter issues by severity (low, medium, high, critical)',
                ),
            label: z
                .string()
                .optional()
                .describe(
                    'Filter issues by label type (e.g., "bug", "security", "performance")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_ISSUES',
            description:
                'List all issues detected by Kodus with advanced filtering by repository, status, severity, or label. Use this to track code quality issues, bugs, or security vulnerabilities.',
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
                async (args: InputType): Promise<IssuesResponse> => {
                    const filter: any = {
                        organizationId: args.organizationId,
                    };

                    if (args.repositoryId)
                        filter.repositoryId = args.repositoryId;
                    if (args.status) filter.status = args.status;
                    if (args.severity) filter.severity = args.severity;
                    if (args.label) filter.label = args.label;

                    const issues = await this.issuesService.findByFilters(
                        filter,
                    );

                    return {
                        success: true,
                        count: issues?.length || 0,
                        data: issues || [],
                    };
                },
                'list_issues',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    getIssue(): McpToolDefinition {
        const inputSchema = z.object({
            issueId: z
                .string()
                .describe(
                    'Issue UUID - unique identifier for the issue to retrieve',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_ISSUE',
            description:
                'Get detailed information about a specific issue including title, description, severity, file location, and related suggestions. Use this to understand an issue in depth.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([IssueSchema, z.null()]),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<IssueResponse> => {
                    const issue = await this.issuesService.findById(
                        args.issueId,
                    );

                    return {
                        success: !!issue,
                        count: issue ? 1 : 0,
                        data: issue || null,
                    };
                },
                'get_issue',
                () => ({ success: false, count: 0, data: null }),
            ),
        };
    }

    getIssuesByFile(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization',
                ),
            repositoryId: z
                .string()
                .describe('Repository ID where the file is located'),
            filePath: z
                .string()
                .describe(
                    'Full path to the file to get issues for (e.g., "src/components/Button.tsx")',
                ),
            status: z
                .nativeEnum(IssueStatus)
                .optional()
                .describe('Filter by issue status (optional)'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_ISSUES_BY_FILE',
            description:
                'Get all issues detected in a specific file. Use this to see file-specific problems, track file quality, or analyze issues in a particular code file.',
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
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<IssuesResponse> => {
                    const issues =
                        await this.issuesService.findByFileAndStatus(
                            args.organizationId,
                            args.repositoryId,
                            args.filePath,
                            args.status,
                        );

                    return {
                        success: true,
                        count: issues?.length || 0,
                        data: issues || [],
                    };
                },
                'get_issues_by_file',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    countIssues(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization',
                ),
            repositoryId: z
                .string()
                .optional()
                .describe('Filter count by specific repository'),
            status: z
                .nativeEnum(IssueStatus)
                .optional()
                .describe('Filter count by status'),
            severity: z
                .nativeEnum(SeverityLevel)
                .optional()
                .describe('Filter count by severity'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_COUNT_ISSUES',
            description:
                'Get the total count of issues matching specific filters. Use this for dashboards, metrics, or quick issue statistics without loading full data.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.object({
                    count: z.number(),
                }),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<IssuesCountResponse> => {
                    const filter: any = {
                        organizationId: args.organizationId,
                    };

                    if (args.repositoryId)
                        filter.repositoryId = args.repositoryId;
                    if (args.status) filter.status = args.status;
                    if (args.severity) filter.severity = args.severity;

                    const count = await this.issuesService.count(filter);

                    return {
                        success: true,
                        count: 1,
                        data: { count },
                    };
                },
                'count_issues',
                () => ({ success: false, count: 0, data: { count: 0 } }),
            ),
        };
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.listIssues(),
            this.getIssue(),
            this.getIssuesByFile(),
            this.countIssues(),
        ];
    }
}

