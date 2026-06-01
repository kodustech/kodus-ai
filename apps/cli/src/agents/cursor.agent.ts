import type { AgentAdapter } from './agent.interface.js';
import { transcriptService } from '../services/transcript.service.js';
import type {
    AgentType,
    LifecycleEvent,
    EventType,
    TokenUsage,
    TranscriptParseResult,
    CursorHookEvent,
} from '../types/session.js';

const HOOK_TO_EVENT_TYPE: Record<CursorHookEvent, EventType> = {
    sessionStart: 'SessionStart',
    sessionEnd: 'SessionEnd',
    stop: 'TurnEnd',
    beforeSubmitPrompt: 'TurnStart',
    subagentStart: 'SubagentStart',
    subagentStop: 'SubagentEnd',
};

/**
 * Cursor agent adapter.
 *
 * Cursor has its own hooks system (.cursor/hooks.json) with payloads that
 * differ from Claude Code. This adapter normalizes Cursor-specific payloads
 * into the shared LifecycleEvent format.
 *
 * Cursor hook payloads (from docs):
 *   sessionStart:       { session_id, is_background_agent, composer_mode }
 *   sessionEnd:         { session_id, reason, duration_ms, error }
 *   beforeSubmitPrompt: { session_id, prompt, attachments }
 *   stop:               { session_id, status, loop_count }
 *   subagentStart:      { session_id, subagent_id, subagent_type, task_description, ... }
 *   subagentStop:       { session_id, subagent_id, subagent_type, status, summary, duration_ms, modified_files, ... }
 */
export class CursorAgent implements AgentAdapter {
    readonly agentType: AgentType = 'cursor';

    parseHookEvent(hookName: string, payload: unknown): LifecycleEvent | null {
        const eventType = HOOK_TO_EVENT_TYPE[hookName as CursorHookEvent];
        if (!eventType) {
            return null;
        }

        const obj =
            payload && typeof payload === 'object' && !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : {};

        const sessionId = pickString(obj, ['session_id', 'sessionId']) ?? '';
        const prompt = pickString(obj, ['prompt']);
        const subagentId = pickString(obj, ['subagent_id', 'subagentId']);
        const subagentType = pickString(obj, ['subagent_type', 'subagentType']);
        const taskDescription = pickString(obj, [
            'task_description',
            'taskDescription',
            'task',
        ]);

        return {
            type: eventType,
            sessionId,
            sessionRef: '',
            prompt,
            timestamp: new Date().toISOString(),
            toolUseId: subagentId,
            subagentId,
            subagentType,
            taskDescription,
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

export const cursorAgent = new CursorAgent();
