import type {
    AgentType,
    FileChange,
    LifecycleEvent,
    TokenUsage,
    ToolCall,
} from '../types/session.js';
import type { SessionApiEvent } from '../types/session-events.js';

export function buildSessionStartEvent(input: {
    sessionId: string;
    branch: string;
    agentType: AgentType;
    gitRemote: string;
    baseCommit: string;
    cliVersion: string;
    timestamp: string;
}): SessionApiEvent {
    return {
        type: 'session_start',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        agentType: input.agentType,
        gitRemote: input.gitRemote,
        baseCommit: input.baseCommit,
        cliVersion: input.cliVersion,
    };
}

export function buildTurnStartEvent(input: {
    sessionId: string;
    branch: string;
    turnId: string;
    prompt: string;
    commitBefore: string;
    timestamp: string;
}): SessionApiEvent {
    return {
        type: 'turn_start',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        turnId: input.turnId,
        prompt: input.prompt,
        commitBefore: input.commitBefore,
    };
}

export function buildTurnEndEvent(input: {
    sessionId: string;
    branch: string;
    turnId: string;
    response: string;
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    commitAfter: string;
    timestamp: string;
}): SessionApiEvent {
    return {
        type: 'turn_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        turnId: input.turnId,
        response: input.response,
        toolCalls: input.toolCalls,
        filesModified: input.filesModified,
        filesRead: input.filesRead,
        commands: input.commands,
        tokenUsage: input.tokenUsage,
        commitAfter: input.commitAfter,
    };
}

export function buildSessionEndEvent(input: {
    sessionId: string;
    branch: string;
    timestamp: string;
}): SessionApiEvent {
    return {
        type: 'session_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
    };
}

export function buildSubagentStartEvent(input: {
    event: LifecycleEvent;
    branch: string;
    timestamp: string;
}): SessionApiEvent {
    const toolInput =
        input.event.toolInput && typeof input.event.toolInput === 'object'
            ? (input.event.toolInput as Record<string, unknown>)
            : {};
    const subagentType =
        input.event.subagentType ??
        pickString(toolInput, 'subagent_type', 'subagentType') ??
        'unknown';
    const taskDescription =
        input.event.taskDescription ??
        pickString(
            toolInput,
            'task_description',
            'taskDescription',
            'description',
            'prompt',
        ) ??
        '';

    return {
        type: 'subagent_start',
        sessionId: input.event.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        toolUseId: input.event.toolUseId ?? '',
        subagentType,
        taskDescription,
    };
}

export function buildSubagentEndEvent(input: {
    sessionId: string;
    branch: string;
    toolUseId: string;
    timestamp: string;
}): SessionApiEvent {
    return {
        type: 'subagent_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        toolUseId: input.toolUseId,
    };
}

function pickString(
    obj: Record<string, unknown>,
    ...keys: string[]
): string | undefined {
    for (const key of keys) {
        const val = obj[key];
        if (typeof val === 'string' && val.trim()) {
            return val.trim();
        }
    }
    return undefined;
}
