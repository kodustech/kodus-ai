import type { AgentType, ToolCall, FileChange, TokenUsage } from './session.js';

// ---------------------------------------------------------------------------
// Session API Events — sent to POST /api/v1/sessions/events
// ---------------------------------------------------------------------------

export type SessionApiEventType =
    | 'session_start'
    | 'turn_start'
    | 'turn_end'
    | 'subagent_start'
    | 'subagent_end'
    | 'session_end';

interface BaseEvent {
    type: SessionApiEventType;
    sessionId: string;
    branch: string;
    timestamp: string;
}

export interface SessionStartEvent extends BaseEvent {
    type: 'session_start';
    agentType: AgentType;
    gitRemote: string;
    baseCommit: string;
    cliVersion: string;
}

export interface TurnStartEvent extends BaseEvent {
    type: 'turn_start';
    turnId: string;
    prompt: string;
    commitBefore: string;
}

export interface TurnEndEvent extends BaseEvent {
    type: 'turn_end';
    turnId: string;
    response: string;
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    commitAfter: string;
}

export interface SubagentStartEvent extends BaseEvent {
    type: 'subagent_start';
    toolUseId: string;
    subagentType: string;
    taskDescription: string;
}

export interface SubagentEndEvent extends BaseEvent {
    type: 'subagent_end';
    toolUseId: string;
}

export interface SessionEndEvent extends BaseEvent {
    type: 'session_end';
}

export type SessionApiEvent =
    | SessionStartEvent
    | TurnStartEvent
    | TurnEndEvent
    | SubagentStartEvent
    | SubagentEndEvent
    | SessionEndEvent;
