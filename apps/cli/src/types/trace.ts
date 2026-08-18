import type { AgentType, FileChange, TokenUsage } from './session.js';

// ---------------------------------------------------------------------------
// Local session records (~/.kodus/sessions/<repoKey>/records/<id>.jsonl)
// ---------------------------------------------------------------------------

export type TraceRecordLine =
    | TraceSessionStartLine
    | TraceTurnStartLine
    | TraceTurnEndLine
    | TraceSessionEndLine;

export interface TraceSessionStartLine {
    kind: 'session-start';
    sessionId: string;
    agentType: AgentType;
    branch: string;
    baseCommit: string;
    gitRemote: string;
    cliVersion: string;
    timestamp: string;
}

export interface TraceTurnStartLine {
    kind: 'turn-start';
    turnId: string;
    /** Redacted before it is written. */
    prompt: string;
    commitBefore: string;
    timestamp: string;
}

export interface TraceToolCallRecord {
    toolName: string;
    /** Redacted one-line rendering of the tool input. */
    summary?: string;
    fileAffected?: string;
}

export interface TraceTurnEndLine {
    kind: 'turn-end';
    turnId: string;
    /** Redacted before it is written. */
    response: string;
    toolCalls: TraceToolCallRecord[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    commitAfter: string;
    timestamp: string;
}

export interface TraceSessionEndLine {
    kind: 'session-end';
    timestamp: string;
}

export interface TraceTurn {
    turnId: string;
    prompt: string;
    response: string;
    toolCalls: TraceToolCallRecord[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage?: TokenUsage;
    commitBefore?: string;
    commitAfter?: string;
    startedAt?: string;
    endedAt?: string;
}

export interface TraceSession {
    sessionId: string;
    agentType?: AgentType;
    branch?: string;
    baseCommit?: string;
    gitRemote?: string;
    cliVersion?: string;
    startedAt?: string;
    endedAt?: string;
    turns: TraceTurn[];
    /** Lines that could not be parsed — a truncated tail, usually. */
    corruptLines: number;
}

export interface TraceSessionSummary {
    sessionId: string;
    agentType?: AgentType;
    branch?: string;
    startedAt?: string;
    endedAt?: string;
    turnCount: number;
    filesTouched: string[];
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const TRACE_DECISION_TYPES = [
    'architectural_decision',
    'convention',
    'tradeoff',
    'implementation_detail',
    'tooling',
    'other',
] as const;

export type TraceDecisionType = (typeof TRACE_DECISION_TYPES)[number];

export type TraceDecisionOrigin = 'human' | 'agent' | 'collaborative';

export interface TraceDecision {
    /** Stable across re-distillation: hash of (branch, decision text, scope). */
    id: string;
    type: TraceDecisionType;
    origin?: TraceDecisionOrigin;
    decision: string;
    rationale?: string;
    confidence?: number;
    evidence?: string[];
    /** Repo-relative paths (or directory prefixes) this decision applies to. */
    scope: string[];
    autoPromoteCandidate?: boolean;
    pinned?: boolean;
    branch?: string;
    commits?: string[];
    sessionIds?: string[];
    createdAt?: string;
}

/** One branch record — the unit written to the orphan branch. */
export interface TraceBranchRecord {
    version: 1;
    branch: string;
    mergeBase: string;
    head: string;
    commits: string[];
    updatedAt: string;
    decisions: TraceDecision[];
    /**
     * Human corrections shared with every clone. Forgotten ids are durable
     * tombstones so re-distillation cannot resurrect the same stable id.
     */
    corrections?: TraceOverrides;
}

export type TraceDecisionSource = 'local' | 'branch';

export interface TraceRecalledDecision extends TraceDecision {
    source: TraceDecisionSource;
    /** Paths from the query that matched this decision's scope. */
    matchedPaths: string[];
}

// ---------------------------------------------------------------------------
// Human corrections
// ---------------------------------------------------------------------------

export interface TraceOverrides {
    forgotten: string[];
    pinned: string[];
}

export interface TraceIncident {
    at: string;
    kind: 'push-collision' | 'distill-failure';
    message: string;
    branch?: string;
}
