// ---------------------------------------------------------------------------
// Lifecycle Events (normalized from any agent)
// ---------------------------------------------------------------------------

export type EventType =
    | 'SessionStart'
    | 'TurnStart'
    | 'TurnEnd'
    | 'SessionEnd'
    | 'SubagentStart'
    | 'SubagentEnd';

export interface LifecycleEvent {
    type: EventType;
    sessionId: string;
    sessionRef: string; // transcript path
    prompt?: string;
    timestamp: string;
    toolUseId?: string;
    subagentId?: string;
    subagentType?: string;
    taskDescription?: string;
    toolInput?: unknown;
}

// ---------------------------------------------------------------------------
// Per-Turn Tracking
// ---------------------------------------------------------------------------

export interface Turn {
    turnId: string;
    timestamp: string;
    prompt: string;
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    commitBefore: string;
    commitAfter?: string;
    tokenUsage: TokenUsage;
}

export interface ToolCall {
    toolName: string;
    toolUseId: string;
    timestamp: string;
    input: Record<string, unknown>;
    output?: string;
    /** True if this is a call to an MCP server tool */
    isMcp: boolean;
    mcpServer?: string;
    fileAffected?: string;
}

export interface FileChange {
    path: string;
    action: 'created' | 'modified' | 'deleted';
}

// ---------------------------------------------------------------------------
// Session Trace (full trace for a session)
// ---------------------------------------------------------------------------

export interface SessionTrace {
    sessionId: string;
    agentType: AgentType;
    branch: string;
    baseCommit: string;
    startedAt: string;
    endedAt?: string;
    turns: Turn[];
    totalTokenUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Decisions (semantic — extracted from traces)
// ---------------------------------------------------------------------------

export type DecisionCategory =
    | 'architecture'
    | 'business_rule'
    | 'pattern'
    | 'dependency';

export type DecisionOrigin = 'user' | 'agent' | 'corrected';

export type DecisionStatus = 'active' | 'superseded' | 'promoted';

export interface Decision {
    id: string;
    sessionId: string;
    turnId: string;
    timestamp: string;
    category: DecisionCategory;
    what: string;
    why: string;
    origin: DecisionOrigin;
    userPrompt?: string;
    agentReasoning?: string;
    files: string[];
    hasTradeoff: boolean;
    tradeoffDescription?: string;
    confidence: number;
    status: DecisionStatus;
    supersededBy?: string;
    /** Set when decision is promoted to team memory */
    memoryId?: string;
}

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
    inputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    apiCallCount: number;
    subagentTokens?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Structured Hook Logging
// ---------------------------------------------------------------------------

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type LogComponent =
    | 'hooks'
    | 'session'
    | 'checkpoint'
    | 'lifecycle'
    | 'transcript';

export interface LogEntry {
    time: string;
    level: LogLevel;
    msg: string;
    component: LogComponent;
    agent?: string;
    hook?: string;
    hook_type?: string;
    model_session_id?: string;
    transcript_path?: string;
    session_id?: string;
    checkpoint_id?: string;
    phase?: string;
    error?: string;
    duration_ms?: number;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentType = 'claude-code' | 'cursor' | 'codex';

export const SUPPORTED_SESSION_AGENTS = new Set<AgentType>([
    'claude-code',
    'cursor',
    'codex',
]);

// ---------------------------------------------------------------------------
// Hook event names per agent
// ---------------------------------------------------------------------------

export type ClaudeCodeHookEvent =
    | 'session-start'
    | 'session-end'
    | 'stop'
    | 'user-prompt-submit'
    | 'subagent-start'
    | 'subagent-stop'
    | 'post-todo'
    // Legacy aliases (kept for backwards compat with existing installations)
    | 'pre-task'
    | 'post-task';

export type CursorHookEvent =
    | 'sessionStart'
    | 'sessionEnd'
    | 'stop'
    | 'beforeSubmitPrompt'
    | 'subagentStart'
    | 'subagentStop';

export type CodexHookEvent = 'AfterAgent' | 'AfterToolUse';

// ---------------------------------------------------------------------------
// Transcript parsing (JSONL)
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
    type: string;
    timestamp?: string;
    message?: TranscriptMessage;
    tool_use_id?: string;
    tool_name?: string;
    content?: unknown;
    usage?: TranscriptUsage;
    subagent_id?: string;
    session_id?: string;
}

export interface TranscriptMessage {
    role: string;
    content: TranscriptContentBlock[] | string;
    usage?: TranscriptUsage;
}

export interface TranscriptContentBlock {
    type: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
}

export interface TranscriptUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface TranscriptParseResult {
    prompts: string[];
    assistantMessages: string[];
    modifiedFiles: string[];
    tokenUsage: TokenUsage;
    summary: string;
    subagentIds: string[];
    entryCount: number;
    /** Structured tool calls extracted from assistant messages */
    toolCalls: ToolCall[];
    /** Files that were read (via Read tool) */
    filesRead: string[];
    /** Bash commands executed */
    commands: string[];
}
