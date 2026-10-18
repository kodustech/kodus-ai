/**
 * Mirrors the custom agent contract in
 * libs/core/infrastructure/config/types/general/codeReview.type.ts and the
 * report shapes of the /code-review/custom-agents endpoints (#2172).
 */

export type CustomAgentSeverity = "low" | "medium" | "high" | "critical";

/**
 * A CLI secret is write-only. A read always returns the mask as
 * `ciphertext`; sending the mask back keeps the stored value, and a new
 * value goes in `value`, which the server encrypts and never stores.
 */
export type CliToolSecret = {
    env: string;
    ciphertext?: string;
    value?: string;
};

export type CliToolConfig = {
    name: string;
    /** Pinned install command, e.g. `npm i -g ledgerctl@1.4.2`. */
    install: string;
    binary: string;
    /** argv must start with one of these; no shell is involved. */
    allowedPrefixes: string[];
    /** Markdown the agent reads to learn how to call the CLI. */
    usage: string;
    /** When true the CLI runs project code, so it never receives secrets. */
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
    format: "inline" | "single-comment";
    minSeverity?: CustomAgentSeverity;
    maxComments?: number;
    suggestedFix: "when-confident" | "never";
    writing?: string;
    /**
     * @deprecated Ignored: custom agents always post. Configs saved while a
     * shadow mode existed may still carry it.
     */
    mode?: "shadow" | "post";
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
    /** BYOK model ids; absent means the routing table decides. */
    models?: { run?: string; check?: string };
    presentation: CustomAgentPresentation;
};

export const KNOWLEDGE_MAIN_REVIEW_TARGET = "main-review" as const;

export type KnowledgeLinkTarget =
    typeof KNOWLEDGE_MAIN_REVIEW_TARGET | { agentId: string };

export type KnowledgeItem = {
    path: string;
    kind: "skill" | "doc";
    linkedTo: KnowledgeLinkTarget[];
};

// ── /code-review/custom-agents/resolve ─────────────────────────────────────

type Section<T> =
    ({ status: "ok" } & T) | { status: "unavailable"; reason: string };

export type KnowledgeValidationIssue = {
    severity: "error" | "warning";
    message: string;
};

export type KnowledgeItemReport = {
    path: string;
    kind: KnowledgeItem["kind"];
    found: boolean;
    name?: string;
    description?: string;
    issues: KnowledgeValidationIssue[];
    tokens?: number;
    linkedTo: KnowledgeLinkTarget[];
    /** The same file also feeds Kody Rules. */
    kodyRuleSource: boolean;
};

export type KnowledgeCandidate = {
    path: string;
    kind: KnowledgeItem["kind"];
    name?: string;
    description?: string;
    /** Set when the skill cannot be read as one (e.g. no frontmatter). */
    errors?: string[];
    kodyRuleSource: boolean;
};

export type KnowledgeTargetBudget = {
    target: string;
    skills: number;
    docs: number;
    docTokens: number;
    over: Array<"skills" | "docs" | "docTokens">;
};

export type ReadOnlyMcpIntegration = {
    integrationId: string;
    name: string;
    tools: Array<{ name: string; description?: string }>;
};

export type CustomAgentResolveReport = {
    repository: { id: string; name: string; branch: string };
    agentIssues: string[];
    astGrep: {
        ruleCount: number;
        ruleIds: string[];
        errors: string[];
        /** Set when the field names a rule file of the repository. */
        rulesPath?: string;
    };
    knowledge: Section<{
        items: KnowledgeItemReport[];
        budgets: KnowledgeTargetBudget[];
        candidates?: KnowledgeCandidate[];
    }>;
    mcp: Section<{ integrations: ReadOnlyMcpIntegration[] }>;
};

// ── /code-review/custom-agents/try ─────────────────────────────────────────

export type CustomAgentTryFinding = {
    file: string;
    lineStart?: number;
    lineEnd?: number;
    severity?: string;
    kind?: "bug" | "convention";
    summary: string;
    body?: string;
    source?: { file: string; section?: string; quote: string };
    verdict: "kept" | "dropped" | "unverified";
    reason?: string;
    wouldPost: boolean;
};

export type CustomAgentTryTrace = {
    status: "completed" | "skipped" | "failed";
    reason?: string;
    models?: { run?: string; check?: string };
    skillsOpened: Array<{ path: string; files?: string[] }>;
    toolCalls: Array<{
        tool: string;
        input?: string;
        outputPreview?: string;
        durationMs?: number;
        error?: string;
    }>;
    findings: CustomAgentTryFinding[];
    /** What the run lost, as a review reports it: no checkout, a CLI not
     *  installed, a skill or doc that could not be used. */
    warnings?: Array<{ kind: string; detail?: string }>;
    durationMs?: number;
};

// ── /code-review/custom-agents/status ──────────────────────────────────────

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
