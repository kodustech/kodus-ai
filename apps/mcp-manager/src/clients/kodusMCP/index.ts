import {
    MCPIntegration,
    MCPProviderType,
    MCPTool,
} from '../../modules/providers/interfaces/provider.interface';

export class KodusMCPClient {
    getIntegrations(): MCPIntegration {
        return {
            id: 'kd_mcp_oTUrzqsaxTg',
            name: 'Kodus MCP',
            description:
                'Manage integrations, manage connections, and manage tools with Kodus MCP integration.',
            authScheme: 'OAUTH',
            appName: 'Kodus MCP',
            logo: 'https://kodus.io/wp-content/uploads/2025/11/Kodus-AI-Logo-6.png',
            isConnected: true,
            provider: MCPProviderType.KODUSMCP,
        };
    }

    getIntegration(): MCPIntegration {
        const tools = this.getTools();
        return {
            ...this.getIntegrations(),
            allowedTools: tools.map((tool) => tool.slug),
        };
    }

    getTools(): MCPTool[] {
        return [
            {
                slug: 'KODUS_LIST_REPOSITORIES',
                name: 'KODUS_LIST_REPOSITORIES',
                description:
                    'List all repositories accessible to the team. Use this to discover available repositories, check repository metadata (private/public, archived status, languages), or when you need to see what repositories exist before performing other operations.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_LIST_PULL_REQUESTS',
                name: 'KODUS_LIST_PULL_REQUESTS',
                description:
                    'List pull requests with advanced filtering (by state, repository, author, date range). Use this to find specific PRs, analyze PR patterns, or get overview of team activity. Returns PR metadata only - use get_pull_request for full PR content.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_LIST_COMMITS',
                name: 'KODUS_LIST_COMMITS',
                description:
                    'List commit history from repositories with filtering by author, date range, or branch. Use this to analyze commit patterns, find specific commits, or track development activity. Returns commit metadata and messages.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_PULL_REQUEST',
                name: 'KODUS_GET_PULL_REQUEST',
                description:
                    'Get complete details of a specific pull request including description, commits, reviews, and list of modified files. Use this when you need full PR context - NOT for file content (use get_pull_request_file_content for that).',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_REPOSITORY_FILES',
                name: 'KODUS_GET_REPOSITORY_FILES',
                description:
                    'Get file tree/listing from a repository branch with pattern filtering. Use this to explore repository structure, find specific files by pattern, or get overview of codebase organization. Returns file paths only - NOT file content.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_REPOSITORY_CONTENT',
                name: 'KODUS_GET_REPOSITORY_CONTENT',
                description:
                    'Get the current content of a specific file from a repository branch. Use this to read files from the main/current branch - NOT from pull requests (use get_pull_request_file_content for PR files).',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_REPOSITORY_LANGUAGES',
                name: 'KODUS_GET_REPOSITORY_LANGUAGES',
                description:
                    'Get programming languages breakdown and statistics for a repository. Use this to understand technology stack, language distribution, or filter repositories by technology.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_PULL_REQUEST_FILE_CONTENT',
                name: 'KODUS_GET_PULL_REQUEST_FILE_CONTENT',
                description:
                    'Get the modified content of a specific file within a pull request context. Use this to read how a file looks AFTER the PR changes are applied - NOT the original version.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_DIFF_FOR_FILE',
                name: 'KODUS_GET_DIFF_FOR_FILE',
                description:
                    'Get the exact diff/patch showing what changed in a specific file within a pull request. Use this to see the precise changes made - additions, deletions, and modifications line by line.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_PULL_REQUEST_DIFF',
                name: 'KODUS_GET_PULL_REQUEST_DIFF',
                description:
                    'Get the complete diff/patch for an entire Pull Request showing all changes across all files. Use this to see the full context of what changed in the PR, including additions, deletions, and modifications across all modified files.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_KODY_RULES',
                name: 'KODUS_GET_KODY_RULES ',
                description:
                    'Get all active Kody Rules at organization level. Use this to see organization-wide coding standards, global rules that apply across all repositories, or when you need a complete overview of all active rules. Returns only ACTIVE status rules.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_KODY_RULES_REPOSITORY',
                name: 'KODUS_GET_KODY_RULES_REPOSITORY',
                description:
                    'Get active Kody Rules specific to a particular repository. Use this to see repository-specific coding standards, rules that only apply to one codebase, or when analyzing rules for a specific project. More focused than get_kody_rules.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_CREATE_KODY_RULE',
                name: 'KODUS_CREATE_KODY_RULE',
                description:
                    'Create a new Kody Rule with custom scope and severity. pull_request scope: analyzes entire PR context for PR-level rules. file scope: analyzes individual files one by one for file-level rules. Rule starts in pending status.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_UPDATE_KODY_RULE',
                name: 'KODUS_UPDATE_KODY_RULE',
                description:
                    'Update an existing Kody Rule. Only the fields provided in kodyRule will be updated. Use this to modify rule details, change severity, scope, or status of existing rules.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_DELETE_KODY_RULE',
                name: 'KODUS_DELETE_KODY_RULE',
                description:
                    'Delete a Kody Rule permanently from the system. This action cannot be undone. Use this to remove rules that are no longer needed or relevant.',
                provider: MCPProviderType.KODUSMCP,
                warning: true,
            },
            {
                slug: 'KODUS_CREATE_KODY_ISSUE',
                name: 'KODUS_CREATE_KODY_ISSUE',
                description:
                    'Create a new Kody Issue linked to a pull request suggestion. Use this to escalate Kody review comments into trackable issues with metadata like file path, severity, and reporter.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_LIST_KODY_ISSUES',
                name: 'KODUS_LIST_KODY_ISSUES',
                description:
                    'List Kody Issues with optional filters (repository, severity, label). Use this to audit outstanding Kody findings, triage by severity, or review the issue backlog.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_GET_KODY_ISSUE_DETAILS',
                name: 'KODUS_GET_KODY_ISSUE_DETAILS',
                description:
                    'Get full details for a specific Kody Issue by id. Use this to inspect metadata, status, and linked suggestions before taking action.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
                name: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
                description:
                    'Update the status of a Kody Issue (e.g. open, resolved, dismissed). Use this to move issues through the workflow directly from MCP.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
                name: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
                description:
                    'Update the category/label for a Kody Issue. Use this to reclassify findings during triage and keep taxonomy accurate.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_DELETE_KODY_ISSUE',
                name: 'KODUS_DELETE_KODY_ISSUE',
                description:
                    'Dismiss a Kody Issue by updating its status to dismissed. Use this when an issue is no longer relevant or was created by mistake.',
                provider: MCPProviderType.KODUSMCP,
                warning: true,
            },
            {
                slug: 'KODUS_CREATE_MEMORY',
                name: 'KODUS_CREATE_MEMORY',
                description:
                    'Create a new memory entry in Kodus MCP. Use this to store important information, context, or notes that can be referenced later within the MCP environment.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
            {
                slug: 'KODUS_FIND_MEMORIES',
                name: 'KODUS_FIND_MEMORIES',
                description:
                    'Search for memories in Kodus MCP using keywords or filters. Use this to quickly retrieve relevant information, context, or notes that have been previously stored.',
                provider: MCPProviderType.KODUSMCP,
                warning: false,
            },
        ];
    }

    updateSelectedTools(
        organizationId: string,
        selectedTools: string[],
    ): { success: boolean; message: string; selectedTools: string[] } {
        return {
            success: true,
            message: 'Selected tools updated successfully',
            selectedTools,
        };
    }
}
