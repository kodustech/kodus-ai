import type { AgentAdapter } from './agent.interface.js';
import { transcriptService } from '../services/transcript.service.js';
import type {
    AgentType,
    LifecycleEvent,
    EventType,
    TokenUsage,
    TranscriptParseResult,
    CodexHookEvent,
} from '../types/session.js';

/**
 * Codex CLI hook-to-event mapping.
 *
 * As of v0.100, Codex only supports two hooks:
 *   - AfterAgent (v0.99+)  — fires after the agent completes a full turn
 *   - AfterToolUse (v0.100+) — fires after each individual tool call
 *
 * Missing hooks (confirmed in development by OpenAI):
 *   - SessionStart / SessionEnd
 *   - UserPromptSubmit (turn_start)
 *   - PreToolUse (blocking)
 *
 * We map AfterAgent → TurnEnd. AfterToolUse is observed but not mapped
 * to a lifecycle event (could be used for analytics later).
 */
const HOOK_TO_EVENT_TYPE: Partial<Record<CodexHookEvent, EventType>> = {
    AfterAgent: 'TurnEnd',
};

export class CodexAgent implements AgentAdapter {
    readonly agentType: AgentType = 'codex';

    parseHookEvent(hookName: string, payload: unknown): LifecycleEvent | null {
        const eventType = HOOK_TO_EVENT_TYPE[hookName as CodexHookEvent];
        if (!eventType) {
            return null;
        }

        const obj =
            payload && typeof payload === 'object' && !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : {};

        // Codex doesn't provide session_id in hook payloads yet.
        // We use the thread_id or conversation_id if available, otherwise
        // fall back to a generated ID that will be consistent within a session
        // via the local state file.
        const sessionId =
            pickString(obj, [
                'session_id',
                'sessionId',
                'thread_id',
                'threadId',
                'conversation_id',
            ]) ?? '';

        return {
            type: eventType,
            sessionId,
            sessionRef: '',
            timestamp: new Date().toISOString(),
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

export const codexAgent = new CodexAgent();
