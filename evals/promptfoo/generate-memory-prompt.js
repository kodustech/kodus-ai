#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PARAMETER_DESCRIPTIONS = {
    organizationId:
        'Organization UUID in Kodus where this operation should run.',
    teamId: 'Team UUID in Kodus associated with the organization context.',
    filters:
        'Optional filter object used to narrow result sets for list operations.',
    archived: 'Filter repositories by archived status.',
    private: 'Filter repositories by visibility (private/public).',
    language: 'Programming language name used for filtering.',
    state: 'Pull request state filter.',
    repository:
        'Repository selector object for operations scoped to a specific repository.',
    repositoryId: 'Repository identifier used by Kodus/code provider.',
    repositoryName: 'Repository name as known by the code provider.',
    author: 'Author identifier or username for filtering results.',
    startDate: 'Inclusive start date for date-range filtering (ISO string).',
    endDate: 'Inclusive end date for date-range filtering (ISO string).',
    since: 'Start timestamp for commit range filtering (ISO string).',
    until: 'End timestamp for commit range filtering (ISO string).',
    branch: 'Branch name used as file/content lookup context.',
    id: 'Unique identifier value.',
    name: 'Human-readable name value.',
    prNumber: 'Pull request number in the target repository.',
    filePath: 'Repository-relative file path.',
    filePatterns: 'Glob patterns to include matching files.',
    excludePatterns: 'Glob patterns to exclude matching files.',
    maxFiles: 'Maximum number of files to return.',
    organizationName:
        'Organization/account name used by the code hosting provider.',
    kodyRule: 'Kody Rule payload object with fields to create or update.',
    title: 'Rule or issue title.',
    rule: 'Rule body describing the coding guideline or constraint.',
    severity: 'Severity level for the item (rule/issue).',
    scope: 'Rule analysis scope (pull_request or file).',
    path: 'File path or glob path constraint.',
    examples: 'Optional code examples illustrating correct/incorrect usage.',
    snippet: 'Code snippet example.',
    isCorrect: 'Whether the snippet is compliant with the rule.',
    directoryId: 'Directory identifier for scoped rule targeting.',
    inheritance: 'Inheritance configuration for rule propagation.',
    inheritable: 'Whether child scopes can inherit this rule.',
    exclude: 'IDs excluded from inheritance.',
    include: 'IDs explicitly included for inheritance.',
    ruleId: 'Kody Rule UUID to update/delete.',
    status: 'Status value for issue/rule state transitions.',
    description: 'Detailed textual description.',
    label: 'Categorization label.',
    platformType: 'Git platform type for repository context.',
    owner: 'Issue owner identity from the git provider.',
    reporter: 'Reporter identity that triggered issue creation.',
    gitId: 'User identifier from git provider.',
    username: 'Username from git provider.',
    originalKodyCommentId: 'Comment ID that originated the issue context.',
    pullRequestNumber: 'Pull request number associated with the issue.',
    repositoryName: 'Repository name to filter issues.',
    issueId: 'Kody Issue UUID.',
};

function enrichSchemaDescriptions(schema, pathSegments = []) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const cloned = { ...schema };

    if (cloned.type === 'object' && cloned.properties) {
        const properties = {};

        for (const [key, value] of Object.entries(cloned.properties)) {
            const nextPath = [...pathSegments, key];
            const enrichedValue = enrichSchemaDescriptions(value, nextPath);
            const description = PARAMETER_DESCRIPTIONS[key];

            properties[key] =
                description &&
                enrichedValue &&
                typeof enrichedValue === 'object' &&
                !enrichedValue.description
                    ? { ...enrichedValue, description }
                    : enrichedValue;
        }

        cloned.properties = properties;
    }

    if (cloned.type === 'array' && cloned.items) {
        cloned.items = enrichSchemaDescriptions(cloned.items, [
            ...pathSegments,
            'items',
        ]);
    }

    return cloned;
}

function withToolDescriptions(tools) {
    return tools.map((tool) => ({
        ...tool,
        parameters: enrichSchemaDescriptions(tool.parameters),
    }));
}

const STANDARD_MCP_TOOLS = [
    {
        name: 'KODUS_LIST_REPOSITORIES',
        description:
            'List all repositories accessible to the team, with optional archived/private/language filters.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                filters: {
                    type: 'object',
                    properties: {
                        archived: { type: 'boolean' },
                        private: { type: 'boolean' },
                        language: { type: 'string' },
                    },
                },
            },
            required: ['organizationId', 'teamId'],
        },
    },
    {
        name: 'KODUS_LIST_PULL_REQUESTS',
        description:
            'List pull requests with filtering by state, repository, author, and date range.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                filters: {
                    type: 'object',
                    properties: {
                        state: {
                            type: 'string',
                            enum: ['opened', 'closed', 'merged'],
                        },
                        repository: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                            },
                        },
                        author: { type: 'string' },
                        startDate: { type: 'string' },
                        endDate: { type: 'string' },
                    },
                },
            },
            required: ['organizationId', 'teamId'],
        },
    },
    {
        name: 'KODUS_LIST_COMMITS',
        description:
            'List commit history with filtering by repository, author, branch, and date range.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                },
                filters: {
                    type: 'object',
                    properties: {
                        since: { type: 'string' },
                        until: { type: 'string' },
                        author: { type: 'string' },
                        branch: { type: 'string' },
                    },
                },
            },
            required: ['organizationId', 'teamId'],
        },
    },
    {
        name: 'KODUS_GET_PULL_REQUEST',
        description:
            'Get complete details of a specific pull request including metadata and modified files.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                },
                prNumber: { type: 'number' },
            },
            required: ['organizationId', 'teamId', 'repository', 'prNumber'],
        },
    },
    {
        name: 'KODUS_GET_REPOSITORY_FILES',
        description:
            'Get repository file tree/listing with include/exclude patterns and max file limits.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                },
                branch: { type: 'string' },
                filePatterns: { type: 'array', items: { type: 'string' } },
                excludePatterns: { type: 'array', items: { type: 'string' } },
                maxFiles: { type: 'number' },
            },
            required: ['organizationId', 'teamId', 'repository'],
        },
    },
    {
        name: 'KODUS_GET_REPOSITORY_CONTENT',
        description:
            'Get file content from a repository branch using repository and organization context.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                },
                organizationName: { type: 'string' },
                filePath: { type: 'string' },
                branch: { type: 'string' },
            },
            required: [
                'organizationId',
                'teamId',
                'repository',
                'organizationName',
                'filePath',
                'branch',
            ],
        },
    },
    {
        name: 'KODUS_GET_PULL_REQUEST_FILE_CONTENT',
        description:
            'Get a file content as modified in a specific pull request context.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                },
                prNumber: { type: 'number' },
                filePath: { type: 'string' },
            },
            required: ['organizationId', 'teamId', 'repository', 'prNumber', 'filePath'],
        },
    },
    {
        name: 'KODUS_GET_DIFF_FOR_FILE',
        description:
            'Get exact patch diff for a specific file in a pull request.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                },
                prNumber: { type: 'number' },
                filePath: { type: 'string' },
            },
            required: ['organizationId', 'teamId', 'repository', 'prNumber', 'filePath'],
        },
    },
    {
        name: 'KODUS_GET_PULL_REQUEST_DIFF',
        description:
            'Get complete aggregated diff for all changed files in a pull request.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                teamId: { type: 'string' },
                repositoryId: { type: 'string' },
                repositoryName: { type: 'string' },
                prNumber: { type: 'number' },
            },
            required: ['organizationId', 'teamId', 'repositoryId', 'prNumber'],
        },
    },
    {
        name: 'KODUS_GET_KODY_RULES',
        description: 'Get active organization-level Kody Rules.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
            },
            required: ['organizationId'],
        },
    },
    {
        name: 'KODUS_GET_KODY_RULES_REPOSITORY',
        description: 'Get active Kody Rules for a specific repository.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                repositoryId: { type: 'string' },
            },
            required: ['organizationId', 'repositoryId'],
        },
    },
    {
        name: 'KODUS_CREATE_KODY_RULE',
        description:
            'Create a Kody Rule with severity, scope, and optional inheritance/examples.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                kodyRule: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        rule: { type: 'string' },
                        severity: { type: 'string' },
                        scope: {
                            type: 'string',
                            enum: ['pull_request', 'file'],
                        },
                        repositoryId: { type: 'string' },
                        path: { type: 'string' },
                        examples: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    snippet: { type: 'string' },
                                    isCorrect: { type: 'boolean' },
                                },
                                required: ['snippet', 'isCorrect'],
                            },
                        },
                        directoryId: { type: 'string' },
                        inheritance: {
                            type: 'object',
                            properties: {
                                inheritable: { type: 'boolean' },
                                exclude: {
                                    type: 'array',
                                    items: { type: 'string' },
                                },
                                include: {
                                    type: 'array',
                                    items: { type: 'string' },
                                },
                            },
                            required: ['inheritable'],
                        },
                    },
                    required: ['title', 'rule', 'severity', 'scope'],
                },
            },
            required: ['organizationId', 'kodyRule'],
        },
    },
    {
        name: 'KODUS_UPDATE_KODY_RULE',
        description:
            'Update fields of an existing Kody Rule (partial update).',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                ruleId: { type: 'string' },
                kodyRule: {
                    type: 'object',
                    properties: {
                        title: { type: 'string' },
                        rule: { type: 'string' },
                        severity: { type: 'string' },
                        scope: {
                            type: 'string',
                            enum: ['pull_request', 'file'],
                        },
                        repositoryId: { type: 'string' },
                        path: { type: 'string' },
                        examples: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    snippet: { type: 'string' },
                                    isCorrect: { type: 'boolean' },
                                },
                            },
                        },
                        directoryId: { type: 'string' },
                        status: { type: 'string' },
                    },
                },
            },
            required: ['organizationId', 'ruleId', 'kodyRule'],
        },
    },
    {
        name: 'KODUS_DELETE_KODY_RULE',
        description: 'Delete a Kody Rule permanently.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                ruleId: { type: 'string' },
            },
            required: ['organizationId', 'ruleId'],
        },
    },
    {
        name: 'KODUS_CREATE_KODY_ISSUE',
        description: 'Create a new Kody Issue manually via MCP.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                filePath: { type: 'string' },
                language: { type: 'string' },
                label: { type: 'string' },
                severity: { type: 'string' },
                repository: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        platformType: { type: 'string' },
                    },
                    required: ['id', 'platformType'],
                },
                owner: {
                    type: 'object',
                    properties: {
                        gitId: { type: 'number' },
                        username: { type: 'string' },
                    },
                },
                reporter: {
                    type: 'object',
                    properties: {
                        gitId: { type: 'number' },
                        username: { type: 'string' },
                    },
                },
                originalKodyCommentId: { type: 'number' },
                pullRequestNumber: { type: 'number' },
            },
            required: [
                'organizationId',
                'title',
                'description',
                'filePath',
                'language',
                'label',
                'severity',
                'repository',
                'originalKodyCommentId',
                'pullRequestNumber',
            ],
        },
    },
    {
        name: 'KODUS_LIST_KODY_ISSUES',
        description: 'List Kody Issues with optional filters.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                repositoryName: { type: 'string' },
                severity: { type: 'string' },
                label: { type: 'string' },
            },
            required: ['organizationId'],
        },
    },
    {
        name: 'KODUS_GET_KODY_ISSUE_DETAILS',
        description: 'Get a Kody Issue by id.',
        parameters: {
            type: 'object',
            properties: {
                organizationId: { type: 'string' },
                issueId: { type: 'string' },
            },
            required: ['issueId'],
        },
    },
    {
        name: 'KODUS_UPDATE_KODY_ISSUE_STATUS',
        description: 'Update issue status.',
        parameters: {
            type: 'object',
            properties: {
                issueId: { type: 'string' },
                status: { type: 'string' },
            },
            required: ['issueId', 'status'],
        },
    },
    {
        name: 'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
        description: 'Update issue category/label.',
        parameters: {
            type: 'object',
            properties: {
                issueId: { type: 'string' },
                label: { type: 'string' },
            },
            required: ['issueId', 'label'],
        },
    },
    {
        name: 'KODUS_DELETE_KODY_ISSUE',
        description: 'Close/dismiss an issue.',
        parameters: {
            type: 'object',
            properties: {
                issueId: { type: 'string' },
            },
            required: ['issueId'],
        },
    },
];

function loadStandardMcpTools() {
    return withToolDescriptions(STANDARD_MCP_TOOLS);
}

async function main() {
    const projectRoot = path.resolve(__dirname, '../..');
    const flowRoot = path.join(projectRoot, 'packages', 'kodus-flow');
    const standardMcpTools = loadStandardMcpTools();

    const strategyPromptsModule = await import(
        pathToFileURL(
            path.join(
                flowRoot,
                'src/engine/strategies/prompts/strategy-prompts.ts',
            ),
        ).href
    );

    const { StrategyPromptFactory } = strategyPromptsModule;

    const userLanguage = 'en-US';
    const identity = {
        description: 'Intelligent conversation agent for user interactions.',
        goal: 'Engage in natural, helpful conversations while respecting user language preferences',
        language: userLanguage,
        languageInstructions: `LANGUAGE REQUIREMENTS:
- Respond in the user's preferred language: ${userLanguage}
- Default to English if no language preference is configured
- Maintain consistent language throughout conversation
- Use appropriate terminology and formatting for the selected language
- Adapt communication style to the target language conventions`,
    };

    const memoryTool = {
        name: 'KODUS_CREATE_MEMORY',
        description:
'Capture a memory, preference, or coding rule derived from context to influence future interactions or code generation. Invoke this tool whenever the user demonstrates an explicit or implicit intent to save a memory, establish a convention, or note a preference. Focus on capturing the user intent rather than strictly evaluating it as a permanent architectural rule. AVOID: Transient task instructions ("Fix this now"), debugging chatter ("I see an error"), questions ("What is the deadline?"), or vague statements without clear actionable information.',
        parameters: {
            type: 'object',
            properties: {
                rule: {
                    type: 'string',
                    description:
'The specific fact, instruction, or preference to remember (e.g., "Use functional components over classes", "We are currently focusing on the frontend API integration").',
                },
                triggerType: {
                    type: 'string',
                    enum: ['explicit', 'implicit'],
                    description:
'Use "explicit" when the user directly asks to save or remember something. Use "implicit" when the user states a fact, convention, or preference that would be helpful context for future interactions.',
                },
                confidence: {
                    type: 'number',
                    description:
'0.0 to 1.0. Represents how clear the user\'s intent was. Use higher scores for direct commands or clear factual statements, and lower scores if the user sounds uncertain.',
                },
                rationale: {
                    type: 'string',
                    description:
'A brief explanation of why this memory is being saved based on the user\'s explicit request or implied context.',
                },
                scope: {
                    type: 'object',
                    description: 'The architectural boundary where this rule remains valid.',
                    properties: {
                        level: {
                            type: 'string',
                            enum: ['directory', 'repository', 'organization'],
                            description:
'Scope level for this memory preference proposal. Directory-level scope uses a glob pattern inside the current repository, repository-level scope applies across the current repository, while organization-level scope applies across repositories in the organization.',
                        },
                        target: {
                            type: 'string',
                            description:
'In directories, the specific path, using glob patterns (e.g., "src/components/ui", "src/**/*.ts").',
                        },
                    },
                    required: ['level'],
                },
            },
            required: [
                'rule',
                'triggerType',
                'confidence',
                'rationale',
                'scope',
            ],
        },
    };

    const promptFactory = new StrategyPromptFactory();

    const context = {
        input: '{{conversation}}',
        mode: 'executor',
        config: {
            scratchpad: {
                enabled: false,
            },
        },
        currentIteration: 0,
        maxIterations: 10,
        history: [],
        agentContext: {
            agentIdentity: identity,
            availableTools: [memoryTool, ...standardMcpTools],
            thread: {
                id: '{{threadId}}',
                metadata: { type: 'conversation' },
            },
            sessionId: '{{sessionId}}',
            correlationId: '{{correlationId}}',
            tenantId: 'kodus-agent-conversation',
            agentExecutionOptions: {
                userContext: {
                    additional_information: '{{additionalInformation}}',
                },
            },
        },
    };

    const prompts = promptFactory.createReActPrompt(context);

    const output = [
        {
            role: 'system',
            content: prompts.systemPrompt,
        },
        {
            role: 'user',
            content: prompts.userPrompt,
        },
    ];

    const outputPath = path.join(__dirname, 'generated-memory-prompt.json');
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`Conversation memory prompt generated from kodus-flow: ${outputPath}`);
    console.log(`Included ${standardMcpTools.length} standard Kodus MCP tools`);
}

main().catch((error) => {
    console.error('Failed to generate memory prompt from conversation flow');
    console.error(error);
    process.exit(1);
});
