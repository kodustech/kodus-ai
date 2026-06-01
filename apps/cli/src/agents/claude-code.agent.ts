import type { AgentAdapter } from './agent.interface.js';
import { transcriptService } from '../services/transcript.service.js';
import type {
    AgentType,
    LifecycleEvent,
    EventType,
    TokenUsage,
    TranscriptParseResult,
    ClaudeCodeHookEvent,
} from '../types/session.js';

const HOOK_TO_EVENT_TYPE: Record<ClaudeCodeHookEvent, EventType> = {
    'session-start': 'SessionStart',
    'session-end': 'SessionEnd',
    'stop': 'TurnEnd',
    'user-prompt-submit': 'TurnStart',
    'subagent-start': 'SubagentStart',
    'subagent-stop': 'SubagentEnd',
    'post-todo': 'TurnEnd',
    // Legacy aliases — old installations used PreToolUse(Task)/PostToolUse(Task)
    'pre-task': 'SubagentStart',
    'post-task': 'SubagentEnd',
};

export class ClaudeCodeAgent implements AgentAdapter {
    readonly agentType: AgentType = 'claude-code';

    parseHookEvent(hookName: string, payload: unknown): LifecycleEvent | null {
        const eventType = HOOK_TO_EVENT_TYPE[hookName as ClaudeCodeHookEvent];
        if (!eventType) {
            return null;
        }

        const obj =
            payload && typeof payload === 'object' && !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : {};

        const sessionId = pickString(obj, ['session_id', 'sessionId']) ?? '';
        const sessionRef =
            pickString(obj, [
                'transcript_path',
                'transcriptPath',
                'session_ref',
            ]) ?? '';
        const prompt = pickString(obj, ['prompt', 'user_message']);
        const toolUseId = pickString(obj, ['tool_use_id', 'toolUseId']);
        const subagentId = pickString(obj, ['subagent_id', 'subagentId']);
        const subagentType = pickString(obj, ['subagent_type', 'subagentType']);
        const taskDescription = pickString(obj, [
            'task_description',
            'taskDescription',
        ]);

        let toolInput: unknown;
        if (obj['tool_input'] !== undefined) {
            toolInput = obj['tool_input'];
        } else if (obj['input'] !== undefined) {
            toolInput = obj['input'];
        }

        return {
            type: eventType,
            sessionId,
            sessionRef,
            prompt,
            timestamp: new Date().toISOString(),
            toolUseId,
            subagentId,
            subagentType,
            taskDescription,
            toolInput,
        };
    }

    async readTranscript(
        transcriptPath: string,
        fromOffset = 0,
    ): Promise<TranscriptParseResult> {
        return transcriptService.parse(transcriptPath, fromOffset);
    }

    async extractPrompts(transcriptPath: string): Promise<string[]> {
        return transcriptService.extractPrompts(transcriptPath);
    }

    async extractSummary(transcriptPath: string): Promise<string> {
        return transcriptService.extractSummary(transcriptPath);
    }

    async extractModifiedFiles(transcriptPath: string): Promise<string[]> {
        return transcriptService.extractModifiedFiles(transcriptPath);
    }

    async calculateTokenUsage(transcriptPath: string): Promise<TokenUsage> {
        return transcriptService.calculateTokenUsage(transcriptPath);
    }

    async waitForTranscriptFlush(
        transcriptPath: string,
        timeoutMs = 3000,
    ): Promise<boolean> {
        return transcriptService.waitForFlush(transcriptPath, timeoutMs);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(
    obj: Record<string, unknown>,
    keys: string[],
): string | undefined {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

export const claudeCodeAgent = new ClaudeCodeAgent();
