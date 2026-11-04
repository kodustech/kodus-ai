/**
 * Mirrors the custom agent contract (#2172): customAgentConfigSchema in
 * libs/core/infrastructure/config/types/general/codeReview.type.ts and the
 * /code-review/custom-agents report shapes the web app reads
 * (apps/web/src/lib/services/custom-agents/types.ts).
 */

export type CustomAgentSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Write-only: a read returns the mask in `ciphertext`; a new value goes in `value`. */
export type CliToolSecret = {
    env: string;
    ciphertext?: string;
    value?: string;
};

export type CliToolConfig = {
    name: string;
    install: string;
    binary: string;
    allowedPrefixes: string[];
    usage: string;
    runsProjectCode: boolean;
    secrets?: CliToolSecret[];
    allowedDomains: string[];
    timeoutSec?: number;
};

export type CustomAgentMcpTools = {
    integrationId: string;
    tools: string[];
};

export type CustomAgentPresentation = {
    tag: { color: string };
    format: 'inline' | 'single-comment';
    minSeverity?: CustomAgentSeverity;
    maxComments?: number;
    suggestedFix: 'when-confident' | 'never';
    writing?: string;
};

export type CustomAgent = {
    id: string;
    name: string;
    enabled: boolean;
    instructions: string;
    scope: { include?: string[]; exclude?: string[] };
    tools: {
        astGrepConfig?: string;
        mcp?: CustomAgentMcpTools[];
        cli?: CliToolConfig[];
    };
    models?: { run?: string };
    presentation: CustomAgentPresentation;
};

export const KNOWLEDGE_MAIN_REVIEW_TARGET = 'main-review' as const;

export type KnowledgeLinkTarget =
    typeof KNOWLEDGE_MAIN_REVIEW_TARGET | { agentId: string };

export type KnowledgeItem = {
    path: string;
    kind: 'skill' | 'doc';
    linkedTo: KnowledgeLinkTarget[];
};

/** One field of the formatted config: its value and the level it comes from. */
export type FormattedNode<T> = {
    value?: T;
    level?: string;
    overriddenValue?: T;
    overriddenLevel?: string;
};

export type FormattedConfigs = {
    customAgents?: FormattedNode<CustomAgent[]>;
    knowledge?: FormattedNode<KnowledgeItem[]>;
    [key: string]: unknown;
};

export type FormattedDirectory = {
    id: string;
    name?: string;
    path?: string;
    folders?: Array<{ id?: string; name?: string; path?: string }>;
    configs?: FormattedConfigs;
    customAgentsRevision?: string;
    knowledgeRevision?: string;
};

export type FormattedRepository = {
    id: string;
    name: string;
    configs?: FormattedConfigs;
    directories?: FormattedDirectory[];
    customAgentsRevision?: string;
    knowledgeRevision?: string;
};

/** `GET /parameters/code-review-parameter` — the config the settings pages load. */
export type FormattedCodeReviewParameter = {
    uuid?: string;
    configValue: {
        configs?: FormattedConfigs;
        repositories?: FormattedRepository[];
        customAgentsRevision?: string;
        knowledgeRevision?: string;
    };
};

export type ExpectedCustomAgentsRevisions = {
    customAgents?: string;
    knowledge?: string;
};

export type SaveCustomAgentsRequest = {
    configValue: {
        customAgents?: CustomAgent[];
        knowledge?: KnowledgeItem[];
    };
    organizationAndTeamData: { teamId: string };
    repositoryId?: string;
    directoryId?: string;
    expectedRevisions?: ExpectedCustomAgentsRevisions;
};

export type CentralizedPrResult = {
    mode: 'centralized-pr';
    prUrl?: string;
    prNumber?: number;
    reused?: boolean;
    pending?: boolean;
    message?: string;
};

export type CustomAgentStatus = {
    agentId: string;
    pullRequests: number;
    posted: number;
    dropped: number;
};

export type CustomAgentsStatus = {
    windowDays: number;
    agents: CustomAgentStatus[];
};

export type CustomAgentTryFinding = {
    file: string;
    lineStart?: number;
    lineEnd?: number;
    severity?: string;
    kind?: 'bug' | 'convention';
    summary: string;
    body?: string;
    source?: { file: string; section?: string; quote: string };
    verdict: 'kept' | 'dropped' | 'unverified';
    reason?: string;
    wouldPost: boolean;
    comment?: string;
};

export type CustomAgentTryTrace = {
    status: 'completed' | 'incomplete' | 'skipped' | 'failed';
    reason?: string;
    models?: { run?: string };
    skillsOpened: Array<{ path: string; files?: string[] }>;
    toolCalls: Array<{
        tool: string;
        input?: string;
        outputPreview?: string;
        durationMs?: number;
        error?: string;
    }>;
    findings: CustomAgentTryFinding[];
    warnings?: Array<{ kind: string; detail?: string }>;
    durationMs?: number;
};

export type TryRunView = {
    runId: string;
    status: 'running' | 'done';
    result?: CustomAgentTryTrace;
};

export type TryCustomAgentRequest = {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
    prUrl: string;
    agent: CustomAgent;
    knowledge?: KnowledgeItem[];
};

// ── /code-review/custom-agents/resolve (what the Skills & docs page reads) ─

export type KnowledgeValidationIssue = {
    severity: 'error' | 'warning';
    message: string;
};

export type KnowledgeItemReport = {
    path: string;
    kind: KnowledgeItem['kind'];
    found: boolean;
    name?: string;
    description?: string;
    issues: KnowledgeValidationIssue[];
    tokens?: number;
    linkedTo: KnowledgeLinkTarget[];
    kodyRuleSource: boolean;
};

export type KnowledgeCandidate = {
    path: string;
    kind: KnowledgeItem['kind'];
    name?: string;
    description?: string;
    errors?: string[];
    kodyRuleSource: boolean;
};

export type KnowledgeTargetBudget = {
    /** `main-review` or `agent:<id>`. */
    target: string;
    skills: number;
    docs: number;
    docTokens: number;
    over: Array<'skills' | 'docs' | 'docTokens'>;
};

export type KnowledgeResolveSection =
    | {
          status: 'ok';
          items: KnowledgeItemReport[];
          budgets: KnowledgeTargetBudget[];
          candidates?: KnowledgeCandidate[];
      }
    | { status: 'unavailable'; reason: string };

export type CustomAgentResolveReport = {
    repository: { id: string; name: string; branch: string };
    knowledge: KnowledgeResolveSection;
    [key: string]: unknown;
};

export type ResolveCustomAgentRequest = {
    teamId: string;
    repositoryId: string;
    knowledge?: KnowledgeItem[];
    discover?: boolean;
};
