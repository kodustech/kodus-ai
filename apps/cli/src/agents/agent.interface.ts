import type {
    LifecycleEvent,
    AgentType,
    TokenUsage,
    TranscriptParseResult,
} from '../types/session.js';

/**
 * Base interface for agent adapters.
 * Each supported agent (Claude Code, Cursor, Codex) implements this
 * to normalize hook payloads into LifecycleEvents.
 */
export interface AgentAdapter {
    readonly agentType: AgentType;

    /**
     * Parse a raw hook payload into a normalized LifecycleEvent.
     */
    parseHookEvent(hookName: string, payload: unknown): LifecycleEvent | null;

    /**
     * Read and parse the agent's transcript file.
     * @param transcriptPath Path to the transcript file.
     * @param fromOffset Start parsing from this byte offset (for incremental).
     */
    readTranscript(
        transcriptPath: string,
        fromOffset?: number,
    ): Promise<TranscriptParseResult>;

    /**
     * Extract prompts from a parsed transcript.
     */
    extractPrompts(transcriptPath: string): Promise<string[]>;

    /**
     * Extract the last assistant message as a summary.
     */
    extractSummary(transcriptPath: string): Promise<string>;

    /**
     * Extract modified files from tool_use blocks in the transcript.
     */
    extractModifiedFiles(transcriptPath: string): Promise<string[]>;

    /**
     * Calculate token usage from assistant messages in the transcript.
     */
    calculateTokenUsage(transcriptPath: string): Promise<TokenUsage>;

    /**
     * Wait for the transcript to be flushed to disk after the agent finishes.
     * Uses a sentinel detection approach (polling for no new writes).
     */
    waitForTranscriptFlush(
        transcriptPath: string,
        timeoutMs?: number,
    ): Promise<boolean>;
}
