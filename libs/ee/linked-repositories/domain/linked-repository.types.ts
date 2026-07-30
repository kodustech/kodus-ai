/**
 * Cross-repo context (#1576) — configuration and runtime types for
 * repositories linked as review context.
 *
 * Enterprise Code (`libs/ee/`) — see `license_ee.md`. Not AGPL.
 *
 * Config shape (kodus-config.yml / CodeReviewConfig):
 * ```yaml
 * linkedRepositories:
 *   - repository: "org/backend-api"
 *     instructions: "REST API this frontend consumes"
 *     ref: main   # optional pin; default = same-branch cascade
 * ```
 */

/** Soft cap on linked repos consulted per review (attention/latency). */
export const MAX_LINKED_REPOSITORIES = 3;

/**
 * One entry from code-review config (file or settings). Relationships are
 * directional: they apply to reviews of the declaring repo only.
 */
export type LinkedRepositoryConfig = {
    /** Full name of the linked repo (`owner/repo`, or provider path). */
    repository: string;
    /** Free-text hint for the agent (what the link is for). */
    instructions?: string;
    /** Optional ref pin. When omitted, cascade: PR head branch → default branch. */
    ref?: string;
};

/** Status of a single linked-repo resolution / clone. */
export type LinkedRepositoryStatus =
    | 'pending'
    | 'ready'
    | 'skipped'
    | 'failed';

/**
 * One candidate in the CodeRabbit-style ref cascade.
 * Tried in order at clone time; first successful fetch wins.
 */
export type LinkedRefCandidate = {
    /**
     * What `git fetch` pulls: branch name, SHA, or provider PR ref
     * (e.g. `refs/pull/123/head`).
     */
    fetchRef: string;
    /**
     * Human-facing label for summary/telemetry
     * (e.g. `open PR #123`, `feature/x`, `main`).
     */
    displayRef: string;
    source:
        | 'pr-description'
        | 'config-pin'
        | 'open-pr'
        | 'head-branch'
        | 'default'
        | 'fallback';
    /** Set when the candidate comes from a PR number (description or open PR). */
    prNumber?: number;
};

/**
 * A linked repository after validation against the team's connected repos.
 * Invalid entries are dropped (never silently — warnings are collected).
 */
export type ResolvedLinkedRepository = {
    /** Original config entry (repository string as written). */
    repository: string;
    /** Canonical full name from the team's connected repo list. */
    fullName: string;
    /** Platform repository id (for getCloneParams). */
    id: string;
    /** Short name (last path segment). */
    name: string;
    /** Optional agent instructions. */
    instructions?: string;
    /**
     * Primary preferred ref (first cascade candidate). Kept for prompts /
     * backwards compatibility with list() consumers.
     */
    preferredRef: string;
    /** Ordered cascade of refs to try at clone time. */
    refCandidates: LinkedRefCandidate[];
    /** Default branch of the linked repo (cascade fallback). */
    defaultBranch: string;
    /** Absolute root path once cloned (`<sandbox>/_linked/<slug>`). */
    rootPath: string;
    status: LinkedRepositoryStatus;
    /** Human-readable reason when status is skipped/failed. */
    reason?: string;
    /** Ref actually checked out after cascade (set on ready) — display form. */
    resolvedRef?: string;
    /** Fetch ref that succeeded (may differ from display, e.g. PR refs). */
    resolvedFetchRef?: string;
    /** Source of the winning ref (for summary transparency). */
    resolvedSource?: LinkedRefCandidate['source'];
    /** When reviewed against an open PR, its number. */
    resolvedPrNumber?: number;
};

/** Outcome of the deterministic pre-LLM boundary gate. */
export type CrossRepoGateMetadata = {
    /** False ⇒ linked-repo tools and boundary prompt were not armed. */
    activate: boolean;
    reasons: string[];
    /** Compact signal kinds that fired (no file content in telemetry). */
    signalKinds: string[];
    signalCount: number;
};

/** Review-level metadata for transparency + telemetry (no code content). */
export type LinkedRepositoriesReviewMetadata = {
    configured: number;
    resolved: number;
    cloned: number;
    failed: number;
    warnings: string[];
    /** Deterministic gate decision; present whenever links are configured. */
    gate?: CrossRepoGateMetadata;
    repositories: Array<{
        repository: string;
        ref?: string;
        /** e.g. open-pr / pr-description / config-pin / head-branch / default */
        source?: LinkedRefCandidate['source'];
        prNumber?: number;
        status: LinkedRepositoryStatus;
        reason?: string;
    }>;
};

/**
 * Lazy access surface exposed to agent tools.
 * Clones happen on first tool access that names a linked repo — never at
 * sandbox creation. Failures are non-blocking.
 */
export interface LinkedRepoAccess {
    /** Whitelist of linked repos the agent may hop into (by fullName). */
    list(): ReadonlyArray<{
        repository: string;
        instructions?: string;
        preferredRef: string;
        status: LinkedRepositoryStatus;
    }>;
    /**
     * Ensure the named repo is cloned and return its absolute root.
     * Accepts fullName or trailing name segment. Rejects unknown names.
     */
    ensureCloned(
        repoKey: string,
    ): Promise<
        | { ok: true; rootPath: string; repository: string; ref: string }
        | { ok: false; error: string }
    >;
    /** Snapshot for review metadata / end-review transparency. */
    getMetadata(): LinkedRepositoriesReviewMetadata;
}
