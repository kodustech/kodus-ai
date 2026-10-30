import type {
    AgentType,
    FileChange,
    LifecycleEvent,
    TokenUsage,
    ToolCall,
} from '../types/session.js';
import type { SessionApiEvent } from '../types/session-events.js';
import { redact, redactDeep, type Redacted } from './trace/redaction.js';

export function buildSessionStartEvent(input: {
    sessionId: string;
    branch: string;
    agentType: AgentType;
    gitRemote: string;
    baseCommit: string;
    cliVersion: string;
    timestamp: string;
}): SessionApiEvent {
    return redactDeep({
        type: 'session_start',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        agentType: input.agentType,
        gitRemote: input.gitRemote,
        baseCommit: input.baseCommit,
        cliVersion: input.cliVersion,
    });
}

/**
 * `prompt` is `Redacted`, not `string`, so an unredacted transcript cannot
 * reach the API by accident — the only way to produce that type is `redact()`.
 */
export function buildTurnStartEvent(input: {
    sessionId: string;
    branch: string;
    turnId: string;
    prompt: Redacted;
    commitBefore: string;
    timestamp: string;
}): SessionApiEvent {
    return redactDeep({
        type: 'turn_start',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        turnId: input.turnId,
        prompt: input.prompt,
        commitBefore: input.commitBefore,
    });
}

/** `response` is `Redacted` for the same reason as `buildTurnStartEvent`. */
export function buildTurnEndEvent(input: {
    sessionId: string;
    branch: string;
    turnId: string;
    response: Redacted;
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    commitAfter: string;
    timestamp: string;
}): SessionApiEvent {
    return redactDeep({
        type: 'turn_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        turnId: input.turnId,
        response: redact(input.response),
        // Tool inputs and shell commands are free text the agent assembled, so
        // they get the same treatment as the prompt rather than being trusted.
        toolCalls: input.toolCalls.map((call) => ({
            ...call,
            input: redactDeep(call.input),
            output: call.output ? redact(call.output) : call.output,
        })),
        filesModified: input.filesModified,
        filesRead: input.filesRead,
        commands: input.commands.map((command) => redact(command)),
        tokenUsage: input.tokenUsage,
        commitAfter: input.commitAfter,
    });
}

export function buildSessionEndEvent(input: {
    sessionId: string;
    branch: string;
    timestamp: string;
}): SessionApiEvent {
    return redactDeep({
        type: 'session_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
    });
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

    return redactDeep({
        type: 'subagent_start',
        sessionId: input.event.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        toolUseId: input.event.toolUseId ?? '',
        subagentType,
        taskDescription: redact(taskDescription),
    });
}

export function buildSubagentEndEvent(input: {
    sessionId: string;
    branch: string;
    toolUseId: string;
    timestamp: string;
}): SessionApiEvent {
    return redactDeep({
        type: 'subagent_end',
        sessionId: input.sessionId,
        branch: input.branch,
        timestamp: input.timestamp,
        toolUseId: input.toolUseId,
    });
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
