import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { PullRequestState } from '@libs/core/domain/enums';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

import { BaseResponse, McpToolDefinition } from '../types/mcp-tool.interface';
import { wrapToolHandler } from '../utils/mcp-protocol.utils';

const RepositorySchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    http_url: z.string(),
    avatar_url: z.string(),
    organizationName: z.string(),
    visibility: z.enum(['public', 'private']),
    selected: z.boolean(),
    default_branch: z.string().optional(),
    project: z
        .looseObject({
            id: z.string(),
            name: z.string(),
        })
        .optional(),
    workspaceId: z.string().optional(),
});

const PullRequestSchema = z.looseObject({
    id: z.string(),
    number: z.number(),
    pull_number: z.number(), // TODO: remove, legacy, use number
    body: z.string(),
    title: z.string(),
    message: z.string(),
    state: z.enum(Object.values(PullRequestState) as [PullRequestState]),
    organizationId: z.string(),
    repository: z.string(), // TODO: remove, legacy, use repositoryData
    repositoryId: z.string(), // TODO: remove, legacy, use repositoryData
    repositoryData: z.looseObject({
        // TODO: consider removing this, use HEAD and BASE instead
        id: z.string(),
        name: z.string(),
    }),
    prURL: z.url(),
    created_at: z.string(),
    closed_at: z.string(),
    updated_at: z.string(),
    merged_at: z.string(),
    participants: z.array(
        z.looseObject({
            id: z.string(),
        }),
    ),
    reviewers: z.array(
        z.looseObject({
            id: z.string(),
        }),
    ),
    sourceRefName: z.string(), // TODO: remove, legacy, use head.ref
    head: z.looseObject({
        ref: z.string(),
        repo: z.looseObject({
            id: z.string(),
            name: z.string(),
            defaultBranch: z.string(),
            fullName: z.string(),
        }),
    }),
    targetRefName: z.string(), // TODO: remove, legacy, use base.ref
    base: z.looseObject({
        ref: z.string(),
        repo: z.looseObject({
            id: z.string(),
            name: z.string(),
            defaultBranch: z.string(),
            fullName: z.string(),
        }),
    }),
    user: z.looseObject({
        login: z.string(),
        name: z.string(),
        id: z.string(),
    }),
});

const PullRequestWithFilesSchema = PullRequestSchema.extend({
    modified_files: z
        .array(
            z.object({
                filename: z.string(),
            }),
        )
        .optional(),
}).passthrough();

const CommitSchema = z.any();

const RepositoryFileSchema = z.looseObject({
    path: z.string(),
    sha: z.string().optional(),
    size: z.number().optional(),
    type: z.string().optional(),
    filename: z.string().optional(),
});

interface RepositoriesResponse extends BaseResponse {
    data: z.infer<typeof RepositorySchema>[];
}

interface PullRequestsResponse extends BaseResponse {
    data: z.infer<typeof PullRequestSchema>[];
}

interface CommitsResponse extends BaseResponse {
    data: z.infer<typeof CommitSchema>[];
}

interface PullRequestResponse extends BaseResponse {
    data: z.infer<typeof PullRequestWithFilesSchema> | null;
}

interface RepositoryFilesResponse extends BaseResponse {
    data: z.infer<typeof RepositoryFileSchema>[];
}

interface RepositoryContentResponse extends BaseResponse {
    success: boolean;
    data: string;
}

interface RepositoryLanguagesResponse extends BaseResponse {
    success: boolean;
    data: string;
}
interface PullRequestFileContentResponse extends BaseResponse {
    success: boolean;
    data: string;
}

interface DiffForFileResponse {
    success: boolean;
    data: string;
}

@Injectable()
export class CodeManagementTools {
    private readonly logger = createLogger(CodeManagementTools.name);
    private static readonly ERROR_MESSAGES = {
        ORGANIZATION_ID_REQUIRED: 'Organization ID is required',
        TEAM_ID_REQUIRED: 'Team ID is required',
        REPOSITORY_ID_REQUIRED: 'Repository ID is required',
        VALID_PR_NUMBER_REQUIRED: 'Valid PR number is required',
        NO_REPOSITORIES_FOUND: 'No repositories found for this organization',
        REPOSITORY_NOT_FOUND: (id: string) =>
            `Repository with ID ${id} not found`,
        FAILED_FETCH_REPOSITORIES: 'Failed to fetch repository information',
        FAILED_FETCH_PR_FILES: (prNumber: number) =>
            `Failed to fetch files for PR #${prNumber}`,
        NO_FILES_FOUND: (prNumber: number) =>
            `No files found for PR #${prNumber}`,
        NO_DIFFS_AVAILABLE: 'No file diffs available for this Pull Request',
        UNEXPECTED_ERROR:
            'An unexpected error occurred while retrieving Pull Request diff',
    } as const;

    constructor(
        private readonly codeManagementService: CodeManagementService,
    ) {}

    listRepositories(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            filters: z
                .object({
                    archived: z
                        .boolean()
                        .optional()
                        .describe(
                            'Filter by archived status: true (only archived repos), false (only active repos), undefined (all repos)',
                        ),
                    private: z
                        .boolean()
                        .optional()
                        .describe(
                            'Filter by visibility: true (only private repos), false (only public repos), undefined (all repos)',
                        ),
                    language: z
                        .string()
                        .optional()
                        .describe(
                            'Filter by primary programming language (e.g., "JavaScript", "TypeScript", "Python")',
                        ),
                })
                .optional()
                .describe('Optional filters to narrow down repository results'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_REPOSITORIES',
            description:
                'List all repositories accessible to the team. Use this to discover available repositories, check repository metadata (private/public, archived status, languages), or when you need to see what repositories exist before performing other operations.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(RepositorySchema),
            }),
            annotations: {
                readOnlyHint: true,
                idempotentHint: true,
                destructiveHint: false,
                openWorldHint: true,
            },
            execute: wrapToolHandler(
                async (args: InputType): Promise<RepositoriesResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        ...args.filters,
                    };

                    const repositories = (
                        await this.codeManagementService.getRepositories(params)
                    ).filter((repo) => repo.selected === true);

                    return {
                        success: true,
                        count: repositories?.length,
                        data: repositories,
                    };
                },
                'list_repositories',
                () => ({ success: false, count: 0, data: [] }),
            ),
        };
    }

    listPullRequests(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            filters: z
                .object({
                    state: z
                        .enum(['opened', 'closed', 'merged'])
                        .optional()
                        .describe(
                            'PR state filter: "opened" (active PRs awaiting review), "closed" (rejected/abandoned PRs), "merged" (accepted and merged PRs). If not specified returns PR in any state',
                        ),
                    repository: z
                        .object({
                            id: z
                                .string()
                                .describe(
                                    'Repository unique identifier (UUID or platform-specific ID)',
                                ),
                            name: z
                                .string()
                                .describe(
                                    'Repository name (e.g., "my-awesome-project")',
                                ),
                        })
                        .optional()
                        .describe(
                            'Specific repository to filter PRs by. If not provided, returns PRs from all accessible repositories',
                        ),
                    author: z
                        .string()
                        .optional()
                        .describe(
                            'GitHub username or email to filter PRs created by a specific author',
                        ),
                    startDate: z
                        .string()
                        .optional()
                        .describe(
                            'ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) to filter PRs created after this date',
                        ),
                    endDate: z
                        .string()
                        .optional()
                        .describe(
                            'ISO date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ) to filter PRs created before this date',
                        ),
                })
                .optional()
                .describe(
                    'Filter criteria to narrow down pull request results',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_PULL_REQUESTS',
            description:
                'List pull requests with advanced filtering (by state, repository, author, date range). Use this to find specific PRs, analyze PR patterns, or get overview of team activity. Returns PR metadata only - use get_pull_request for full PR content.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(PullRequestSchema),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<PullRequestsResponse> => {
                    const params: Parameters<
                        typeof this.codeManagementService.getPullRequests
                    >[0] = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.filters?.repository?.id,
                            name: args.filters?.repository?.name,
                        },
                        filters: {
                            state: args.filters?.state
                                ? PullRequestState[
                                      args.filters.state.toUpperCase()
                                  ]
                                : undefined,
                            startDate: args.filters?.startDate
                                ? new Date(args.filters.startDate)
                                : undefined,
                            endDate: args.filters?.endDate
                                ? new Date(args.filters.endDate)
                                : undefined,
                            author: args.filters?.author,
                        },
                    };

                    const pullRequests =
                        await this.codeManagementService.getPullRequests(
                            params,
                        );

                    return {
                        success: true,
                        count: pullRequests?.length,
                        data: pullRequests,
                    };
                },
            ),
        };
    }

    listCommits(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .optional()
                .describe(
                    'Specific repository to get commits from. If not provided, gets commits from all accessible repositories',
                ),
            filters: z
                .object({
                    since: z
                        .string()
                        .optional()
                        .describe(
                            'ISO date string (YYYY-MM-DDTHH:mm:ssZ) to get commits created after this date',
                        ),
                    until: z
                        .string()
                        .optional()
                        .describe(
                            'ISO date string (YYYY-MM-DDTHH:mm:ssZ) to get commits created before this date',
                        ),
                    author: z
                        .string()
                        .optional()
                        .describe(
                            'Git author name to filter commits by specific contributor',
                        ),
                    branch: z
                        .string()
                        .optional()
                        .describe(
                            'Branch name to get commits from (e.g., "main", "develop", "feature/new-feature")',
                        ),
                })
                .optional()
                .describe(
                    'Optional filters to narrow down commit history results',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_LIST_COMMITS',
            description:
                'List commit history from repositories with filtering by author, date range, or branch. Use this to analyze commit patterns, find specific commits, or track development activity. Returns commit metadata and messages.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(CommitSchema),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<CommitsResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: args.repository,
                        filters: {
                            author: args.filters?.author,
                            startDate: args.filters?.since
                                ? new Date(args.filters.since)
                                : undefined,
                            endDate: args.filters?.until
                                ? new Date(args.filters.until)
                                : undefined,
                            branch: args.filters?.branch,
                        },
                    };

                    const commits =
                        await this.codeManagementService.getCommits(params);

                    return {
                        success: true,
                        count: commits.length,
                        data: commits,
                    };
                },
            ),
        };
    }

    getPullRequest(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe(
                    'Repository information where the pull request is located',
                ),
            prNumber: z
                .number()
                .describe(
                    'Pull request number (e.g., 123 for PR #123) - the sequential number assigned by the platform',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_PULL_REQUEST',
            description:
                'Get complete details of a specific pull request including description, commits, reviews, and list of modified files. Use this when you need full PR context - NOT for file content (use get_pull_request_file_content for that).',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.union([PullRequestWithFilesSchema, z.null()]),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<PullRequestResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id || args.repository.name,
                            name: args.repository.name || args.repository.id,
                        },
                        prNumber: args.prNumber,
                    };

                    const details =
                        await this.codeManagementService.getPullRequest(params);

                    if (!details) {
                        return {
                            success: false,
                            count: 0,
                            data: null,
                        };
                    }

                    const files =
                        await this.codeManagementService.getFilesByPullRequestId(
                            params,
                        );

                    const prDetails = {
                        ...details,
                        modified_files:
                            files?.map((file) => ({
                                filename: file.filename,
                            })) || [],
                    };

                    return {
                        success: true,
                        count: 1,
                        data: prDetails,
                    };
                },
            ),
        };
    }

    getRepositoryFiles(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe(
                    'Repository information to get file tree/listing from',
                ),
            branch: z
                .string()
                .optional()
                .describe(
                    'Branch name to get files from (defaults to default branch if not specified)',
                ),
            filePatterns: z
                .array(z.string())
                .optional()
                .describe(
                    'Array of glob patterns to include specific files (e.g., ["**/*.ts", "src/**/*.js"]). Always matched against full filepath',
                ),
            excludePatterns: z
                .array(z.string())
                .optional()
                .describe(
                    'Array of glob patterns to exclude files (e.g., ["node_modules/**", "**/*.log"]). Always matched against full filepath',
                ),
            maxFiles: z
                .number()
                .prefault(1000)
                .describe(
                    'Maximum number of files to return (defaults to 1000 to prevent overwhelming responses)',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_REPOSITORY_FILES',
            description:
                'Get file tree/listing from a repository branch with pattern filtering. Use this to explore repository structure, find specific files by pattern, or get overview of codebase organization. Returns file paths only - NOT file content.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                count: z.number(),
                data: z.array(RepositoryFileSchema),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<RepositoryFilesResponse> => {
                    const params: Parameters<
                        typeof this.codeManagementService.getRepositoryAllFiles
                    >[0] = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id,
                            name: args.repository.name,
                        },
                        filters: {
                            branch: args.branch,
                            filePatterns: args.filePatterns,
                            excludePatterns: args.excludePatterns,
                            maxFiles: args.maxFiles,
                        },
                    };

                    const files =
                        await this.codeManagementService.getRepositoryAllFiles(
                            params,
                        );

                    return {
                        success: true,
                        count: files?.length ?? 0,
                        data: files,
                    };
                },
            ),
        };
    }

    getRepositoryContent(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe('Repository information where the file is located'),
            organizationName: z
                .string()
                .describe(
                    'Organization name as it appears in the code management platform (e.g., GitHub org name)',
                ),
            filePath: z
                .string()
                .describe(
                    'Full path to the file within the repository (e.g., "src/components/Button.tsx", "README.md")',
                ),
            branch: z
                .string()
                .describe(
                    'Branch name to get the file from. IMPORTANT: Always prioritize in this order: 1 - The PR source/head branch (where the changes are), 2 - The PR target/base branch (where it will be merged), 3 - The repository default branch (use the exact value provided in the context). Always use the branch that is most contextually relevant to the user\'s question. Examples: "main", "develop", "feature/new-feature", "bug/fix-issue".',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_REPOSITORY_CONTENT',
            description:
                'Get the current content of a specific file from a repository branch. Use this to read files from the main/current branch - NOT from pull requests (use get_pull_request_file_content for PR files).',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.string(),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<RepositoryContentResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id || args.repository.name,
                            name: args.repository.name || args.repository.id,
                        },
                        file: {
                            path: args.filePath,
                            filename: args.filePath,
                            organizationName: args.organizationName,
                        },
                        pullRequest: {
                            head: { ref: args.branch },
                            base: { ref: args.branch },
                            branch: args.branch,
                        },
                    };

                    const fileContent =
                        await this.codeManagementService.getRepositoryContentFile(
                            params,
                        );

                    const content =
                        fileContent?.data?.content ?? 'NOT FIND CONTENT';
                    let decodedContent = content;

                    if (content && fileContent?.data?.encoding === 'base64') {
                        decodedContent = Buffer.from(
                            content,
                            'base64',
                        ).toString('utf-8');
                    }

                    return {
                        success: true,
                        data: decodedContent,
                    };
                },
            ),
        };
    }

    getRepositoryLanguages(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe(
                    'Repository information to analyze language distribution',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_REPOSITORY_LANGUAGES',
            description:
                'Get programming languages breakdown and statistics for a repository. Use this to understand technology stack, language distribution, or filter repositories by technology.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.string(),
            }),
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<RepositoryLanguagesResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id || args.repository.name,
                            name: args.repository.name || args.repository.id,
                        },
                    };
                    const languages =
                        await this.codeManagementService.getLanguageRepository(
                            params,
                        );

                    return {
                        success: true,
                        data: languages,
                    };
                },
            ),
        };
    }

    getPullRequestFileContent(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe(
                    'Repository information where the pull request is located',
                ),
            prNumber: z
                .number()
                .describe(
                    'Pull request number (e.g., 123 for PR #123) - the sequential number assigned by the platform',
                ),
            filePath: z
                .string()
                .describe(
                    'Full path to the file within the repository as it appears in the PR (e.g., "src/components/Button.tsx")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_PULL_REQUEST_FILE_CONTENT',
            description:
                'Get the modified content of a specific file within a pull request context. Use this to read how a file looks AFTER the PR changes are applied - NOT the original version.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.string(),
            }),
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<PullRequestFileContentResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id || args.repository.name,
                            name: args.repository.name || args.repository.id,
                        },
                        prNumber: args.prNumber,
                    };

                    const files =
                        await this.codeManagementService.getFilesByPullRequestId(
                            params,
                        );

                    const file = files.find(
                        (f) => f.filename === args.filePath,
                    );

                    if (!file) {
                        return {
                            success: false,
                            data: 'NOT FIND CONTENT',
                        };
                    }

                    const pullRequest =
                        await this.codeManagementService.getPullRequestByNumber(
                            params,
                        );

                    if (!pullRequest) {
                        return {
                            success: false,
                            data: 'NOT FIND CONTENT',
                        };
                    }

                    const fileContent =
                        await this.codeManagementService.getRepositoryContentFile(
                            {
                                organizationAndTeamData:
                                    params.organizationAndTeamData,
                                repository: params.repository,
                                file: { filename: file.filename },
                                pullRequest: {
                                    branch: pullRequest.head.ref,
                                    head: { ref: pullRequest.head.ref },
                                    base: { ref: pullRequest.base.ref },
                                },
                            },
                        );

                    const content =
                        fileContent?.data?.content ?? 'NOT FIND CONTENT';
                    let decodedContent = content;

                    if (content && fileContent?.data?.encoding === 'base64') {
                        decodedContent = Buffer.from(
                            content,
                            'base64',
                        ).toString('utf-8');
                    }

                    return {
                        success: true,
                        data: decodedContent,
                    };
                },
            ),
        };
    }

    getDiffForFile(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team within the organization',
                ),
            repository: z
                .object({
                    id: z
                        .string()
                        .describe(
                            'Repository unique identifier (UUID or platform-specific ID)',
                        ),
                    name: z
                        .string()
                        .describe(
                            'Repository name (e.g., "my-awesome-project")',
                        ),
                })
                .describe(
                    'Repository information where the pull request is located',
                ),
            prNumber: z
                .number()
                .describe(
                    'Pull request number (e.g., 123 for PR #123) - the sequential number assigned by the platform',
                ),
            filePath: z
                .string()
                .describe(
                    'Full path to the file within the repository to get diff for (e.g., "src/components/Button.tsx")',
                ),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_DIFF_FOR_FILE',
            description:
                'Get the exact diff/patch showing what changed in a specific file within a pull request. Use this to see the precise changes made - additions, deletions, and modifications line by line.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.string(),
            }),
            execute: wrapToolHandler(
                async (args: InputType): Promise<DiffForFileResponse> => {
                    const params = {
                        organizationAndTeamData: {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        },
                        repository: {
                            id: args.repository.id || args.repository.name,
                            name: args.repository.name || args.repository.id,
                        },
                        prNumber: args.prNumber,
                        filePath: args.filePath,
                    };

                    const files =
                        await this.codeManagementService.getFilesByPullRequestId(
                            params,
                        );

                    const file = files.find(
                        (f) => f.filename === params.filePath,
                    );

                    return {
                        success: true,
                        data: file?.patch,
                    };
                },
            ),
        };
    }

    getPullRequestDiff(): McpToolDefinition {
        const inputSchema = z.object({
            organizationId: z
                .string()
                .describe(
                    'Organization UUID - unique identifier for the organization in the system',
                ),
            teamId: z
                .string()
                .describe(
                    'Team UUID - unique identifier for the team in the system',
                ),
            repositoryId: z
                .string()
                .describe('Repository unique identifier to get the diff from'),
            repositoryName: z
                .string()
                .optional()
                .describe(
                    'Repository name (optional - will be fetched if not provided)',
                ),
            prNumber: z
                .number()
                .describe('Pull Request number to get the complete diff for'),
        });

        type InputType = z.infer<typeof inputSchema>;

        return {
            name: 'KODUS_GET_PULL_REQUEST_DIFF',
            description:
                'Get the complete diff/patch for an entire Pull Request showing all changes across all files. Use this to see the full context of what changed in the PR, including additions, deletions, and modifications across all modified files.',
            inputSchema,
            outputSchema: z.object({
                success: z.boolean(),
                data: z.string().optional(),
                message: z.string().optional(),
            }),
            execute: wrapToolHandler(
                async (
                    args: InputType,
                ): Promise<
                    BaseResponse & { data?: string; message?: string }
                > => {
                    try {
                        if (!args.organizationId) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES
                                        .ORGANIZATION_ID_REQUIRED,
                            };
                        }

                        if (!args.teamId) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES
                                        .TEAM_ID_REQUIRED,
                            };
                        }

                        if (!args.repositoryId) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES
                                        .REPOSITORY_ID_REQUIRED,
                            };
                        }

                        if (!args.prNumber || args.prNumber <= 0) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES
                                        .VALID_PR_NUMBER_REQUIRED,
                            };
                        }

                        const organizationAndTeamData = {
                            organizationId: args.organizationId,
                            teamId: args.teamId,
                        };

                        let repositoryName = args.repositoryName;

                        if (!repositoryName) {
                            try {
                                const repositories =
                                    await this.codeManagementService.getRepositories(
                                        {
                                            organizationAndTeamData,
                                        },
                                    );

                                if (!repositories?.length) {
                                    return {
                                        success: false,
                                        message:
                                            CodeManagementTools.ERROR_MESSAGES
                                                .NO_REPOSITORIES_FOUND,
                                    };
                                }

                                const repositoryInfo = repositories.find(
                                    (repo) => repo.id === args.repositoryId,
                                );

                                if (!repositoryInfo) {
                                    return {
                                        success: false,
                                        message:
                                            CodeManagementTools.ERROR_MESSAGES.REPOSITORY_NOT_FOUND(
                                                args.repositoryId,
                                            ),
                                    };
                                }

                                repositoryName = repositoryInfo.name;
                            } catch (error) {
                                this.logger.error({
                                    message: 'Failed to fetch repositories',
                                    context: 'CodeManagementTools',
                                    error,
                                    metadata: {
                                        organizationId: args.organizationId,
                                    },
                                });

                                return {
                                    success: false,
                                    message:
                                        CodeManagementTools.ERROR_MESSAGES
                                            .FAILED_FETCH_REPOSITORIES,
                                };
                            }
                        }

                        const repository = {
                            id: args.repositoryId,
                            name: repositoryName,
                        };

                        const pullRequest = {
                            number: args.prNumber,
                        };

                        let changedFiles;
                        try {
                            changedFiles =
                                await this.codeManagementService.getFilesByPullRequestId(
                                    {
                                        organizationAndTeamData,
                                        repository,
                                        prNumber: pullRequest.number,
                                    },
                                );
                        } catch (error) {
                            this.logger.error({
                                message: 'Failed to fetch PR files',
                                context: 'CodeManagementTools',
                                error,
                                metadata: {
                                    repository,
                                    prNumber: args.prNumber,
                                },
                            });

                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES.FAILED_FETCH_PR_FILES(
                                        args.prNumber,
                                    ),
                            };
                        }

                        if (!changedFiles?.length) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES.NO_FILES_FOUND(
                                        args.prNumber,
                                    ),
                            };
                        }

                        const filesWithPatches = changedFiles.filter(
                            this.hasValidPatch.bind(this),
                        );

                        if (!filesWithPatches.length) {
                            return {
                                success: false,
                                message:
                                    CodeManagementTools.ERROR_MESSAGES
                                        .NO_DIFFS_AVAILABLE,
                            };
                        }

                        const completeDiff = filesWithPatches
                            .map((file) => this.formatFileDiff(file))
                            .join('\n\n');

                        return {
                            success: true,
                            data: completeDiff,
                            message: `Successfully retrieved ${filesWithPatches.length} file diffs from PR #${args.prNumber}`,
                        };
                    } catch (error) {
                        this.logger.error({
                            message: 'Unexpected error in getPullRequestDiff',
                            context: 'CodeManagementTools',
                            error,
                            metadata: { args },
                        });

                        return {
                            success: false,
                            message:
                                CodeManagementTools.ERROR_MESSAGES
                                    .UNEXPECTED_ERROR,
                        };
                    }
                },
            ),
        };
    }

    /**
     * Formats a file diff with metadata
     */
    private formatFileDiff(file: any): string {
        const {
            filename,
            status,
            additions = 0,
            deletions = 0,
            changes = 0,
            patch,
        } = file;

        return `=== FILE: ${filename} ===
Status: ${status}
Additions: ${additions}
Deletions: ${deletions}
Changes: ${changes}

${patch}`;
    }

    /**
     * Validates if a file has a valid patch
     */
    private hasValidPatch(file: any): boolean {
        return file?.patch?.trim()?.length > 0;
    }

    getAllTools(): McpToolDefinition[] {
        return [
            this.listRepositories(),
            this.listPullRequests(),
            this.listCommits(),
            this.getPullRequest(),
            this.getRepositoryFiles(),
            this.getRepositoryContent(),
            this.getPullRequestFileContent(),
            this.getDiffForFile(),
            this.getPullRequestDiff(),
        ];
    }
}
