export type CliSessionAgent = 'claude-code' | 'cursor' | 'codex';

export type CliSessionEvent = 'stop';

export type CliSessionDecisionType =
    | 'architectural_decision'
    | 'convention'
    | 'tradeoff'
    | 'implementation_detail'
    | 'tooling'
    | 'other';

export type CliSessionDecisionOrigin = 'human' | 'agent' | 'collaborative';

export interface CliSessionToolUse {
    tool: string;
    filePath?: string;
    summary?: string;
}

export interface CliSessionSignals {
    sessionId?: string;
    turnId?: string;
    prompt?: string;
    assistantMessage?: string;
    modifiedFiles: string[];
    toolUses: CliSessionToolUse[];
}

export interface CliSessionCaptureInput {
    branch: string;
    sha: string | null;
    orgRepo: string | null;
    agent: CliSessionAgent;
    event: CliSessionEvent;
    signals: CliSessionSignals;
    summary?: string;
    capturedAt: string;
}

export interface CliSessionClassifiedDecision {
    type: CliSessionDecisionType;
    origin?: CliSessionDecisionOrigin;
    decision: string;
    rationale?: string;
    confidence?: number;
    evidence?: string[];
    autoPromoteCandidate?: boolean;
    /**
     * Repo-relative paths (or directory prefixes) the decision applies to.
     * This is what makes the lookup path-keyed rather than semantic.
     */
    scope?: string[];
    /** Human correction: a pinned decision always makes the context pack. */
    pinned?: boolean;
}

export interface CliSessionCaptureSubmissionResult {
    id: string;
    accepted: boolean;
}
