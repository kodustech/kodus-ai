import type { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import type {
    CustomAgentConfig,
    KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * Seams the custom agent settings endpoints (#2172) call into. The skills,
 * tools and engine slices implement them; the endpoints degrade to
 * `unavailable` for any seam that is not bound yet.
 */

/** The repository and branch a draft is checked against. */
export type CustomAgentRepositoryRef = {
    id: string;
    name: string;
    /** The default branch: what the next pull request's target reads. */
    branch: string;
};

// ── Skills and docs ────────────────────────────────────────────────────────

export type KnowledgeValidationIssue = {
    severity: 'error' | 'warning';
    message: string;
};

export type KnowledgeItemResolution = {
    path: string;
    kind: KnowledgeItem['kind'];
    /** False when the path does not exist on the branch. */
    found: boolean;
    /** Skills: name and description from the frontmatter. */
    name?: string;
    description?: string;
    /** Skills: the agentskills spec check. Docs: empty. */
    issues: KnowledgeValidationIssue[];
    /** Docs: tokens the whole file costs against the per-target budget. */
    tokens?: number;
};

export type KnowledgeCandidate = {
    path: string;
    kind: KnowledgeItem['kind'];
    name?: string;
    description?: string;
    /** Set when the skill cannot be read as one (e.g. no frontmatter). */
    errors?: string[];
};

export const CUSTOM_AGENT_KNOWLEDGE_READER_TOKEN = Symbol.for(
    'CustomAgentKnowledgeReader',
);

export interface ICustomAgentKnowledgeReader {
    /** Reads each item from the branch and validates it. */
    resolve(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: CustomAgentRepositoryRef;
        items: Array<Pick<KnowledgeItem, 'path' | 'kind'>>;
    }): Promise<KnowledgeItemResolution[]>;

    /** Skills (SKILL.md folders) and docs found on the branch. */
    discover(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: CustomAgentRepositoryRef;
    }): Promise<KnowledgeCandidate[]>;

    /** One file of the branch (an ast-grep rule file); null when absent.
     *  Throws when the file cannot be read as text. */
    readFile?(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: CustomAgentRepositoryRef;
        path: string;
    }): Promise<string | null>;
}

// ── Tools ──────────────────────────────────────────────────────────────────

export type ReadOnlyMcpIntegration = {
    integrationId: string;
    name: string;
    /** Only tools annotated `readOnlyHint`; write tools are never listed. */
    tools: Array<{ name: string; description?: string }>;
};

export const CUSTOM_AGENT_TOOL_CATALOG_TOKEN = Symbol.for(
    'CustomAgentToolCatalog',
);

export interface ICustomAgentToolCatalog {
    listReadOnlyMcpTools(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<ReadOnlyMcpIntegration[]>;
}

// ── Try it ─────────────────────────────────────────────────────────────────

export type CustomAgentTryFinding = {
    file: string;
    lineStart?: number;
    lineEnd?: number;
    severity?: SeverityLevel | string;
    kind?: 'bug' | 'convention';
    summary: string;
    body?: string;
    source?: { file: string; section?: string; quote: string };
    /** What the check decided, and why. */
    verdict: 'kept' | 'dropped' | 'unverified';
    reason?: string;
    /** Kept and above the agent's minimum severity and comment limit. */
    wouldPost: boolean;
    /** A kept finding's comment text, with the rule it cites. */
    comment?: string;
};

export type CustomAgentTryTrace = {
    status: 'completed' | 'skipped' | 'failed';
    /** Why the agent was skipped (no file matched) or failed. */
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
    /** What the run lost, as a review reports it: no checkout, a CLI not
     *  installed, a skill or doc that could not be used. */
    warnings?: Array<{ kind: string; detail?: string }>;
    durationMs?: number;
};

export const CUSTOM_AGENT_TRY_RUNNER_TOKEN = Symbol.for('CustomAgentTryRunner');

export interface ICustomAgentTryRunner {
    /**
     * Runs one agent on a pull request without posting or storing anything.
     * `agent` carries ciphertext secrets, like a stored agent.
     */
    runCustomAgentOnPullRequest(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        prUrl: string;
        agent: CustomAgentConfig;
        knowledge: KnowledgeItem[];
    }): Promise<CustomAgentTryTrace>;
}
