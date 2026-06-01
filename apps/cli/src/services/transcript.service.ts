import fs from 'fs/promises';
import type {
    TokenUsage,
    TranscriptParseResult,
    TranscriptContentBlock,
    ToolCall,
} from '../types/session.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const COMMAND_TOOLS = new Set(['Bash']);

class TranscriptService {
    /**
     * Parse a JSONL transcript file from disk.
     * @param transcriptPath Absolute path to the .jsonl file.
     * @param fromOffset Start parsing from this character offset (for incremental).
     */
    async parse(
        transcriptPath: string,
        fromOffset = 0,
    ): Promise<TranscriptParseResult> {
        const result: TranscriptParseResult = {
            prompts: [],
            assistantMessages: [],
            modifiedFiles: [],
            tokenUsage: emptyTokenUsage(),
            summary: '',
            subagentIds: [],
            entryCount: 0,
            toolCalls: [],
            filesRead: [],
            commands: [],
        };

        const modifiedFilesSet = new Set<string>();
        const filesReadSet = new Set<string>();
        const subagentIdsSet = new Set<string>();
        let lastAssistantText = '';

        let content: string;
        try {
            content = await fs.readFile(transcriptPath, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return result;
            }
            throw error;
        }

        const normalizedOffset = normalizeOffset(content, fromOffset);
        const lines = content.slice(normalizedOffset).split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }

            let entry: Record<string, unknown>;
            try {
                entry = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
                continue;
            }

            result.entryCount++;

            // Handle top-level entries with message field
            const message = entry['message'] as
                | Record<string, unknown>
                | undefined;
            if (message) {
                this.processMessage(
                    message,
                    result,
                    modifiedFilesSet,
                    filesReadSet,
                    (text) => {
                        lastAssistantText = text;
                    },
                );
            }

            // Handle flat entries (role at top level)
            if (!message && typeof entry['role'] === 'string') {
                this.processMessage(
                    entry,
                    result,
                    modifiedFilesSet,
                    filesReadSet,
                    (text) => {
                        lastAssistantText = text;
                    },
                );
            }

            // Subagent tracking
            const subagentId = entry['subagent_id'] as string | undefined;
            if (subagentId) {
                subagentIdsSet.add(subagentId);
            }
        }

        result.modifiedFiles = [...modifiedFilesSet];
        result.filesRead = [...filesReadSet];
        result.subagentIds = [...subagentIdsSet];
        result.summary = lastAssistantText.slice(0, 500);

        return result;
    }

    /**
     * Extract only modified file paths from a transcript.
     */
    async extractModifiedFiles(transcriptPath: string): Promise<string[]> {
        const result = await this.parse(transcriptPath);
        return result.modifiedFiles;
    }

    /**
     * Extract only prompts from a transcript.
     */
    async extractPrompts(transcriptPath: string): Promise<string[]> {
        const result = await this.parse(transcriptPath);
        return result.prompts;
    }

    /**
     * Get the last assistant message as summary.
     */
    async extractSummary(transcriptPath: string): Promise<string> {
        const result = await this.parse(transcriptPath);
        return result.summary;
    }

    /**
     * Calculate total token usage from assistant messages.
     */
    async calculateTokenUsage(transcriptPath: string): Promise<TokenUsage> {
        const result = await this.parse(transcriptPath);
        return result.tokenUsage;
    }

    /**
     * Wait for transcript file to stabilize (no new writes for ~150ms).
     */
    async waitForFlush(
        transcriptPath: string,
        timeoutMs = 3000,
    ): Promise<boolean> {
        const pollInterval = 50;
        const startTime = Date.now();
        let lastSize = -1;
        let stableCount = 0;
        const requiredStable = 3;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const stat = await fs.stat(transcriptPath);
                if (stat.size === lastSize) {
                    stableCount++;
                    if (stableCount >= requiredStable) {
                        return true;
                    }
                } else {
                    stableCount = 0;
                    lastSize = stat.size;
                }
            } catch {
                stableCount = 0;
            }
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }

        return stableCount >= requiredStable;
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private processMessage(
        message: Record<string, unknown>,
        result: TranscriptParseResult,
        modifiedFilesSet: Set<string>,
        filesReadSet: Set<string>,
        onAssistantText: (text: string) => void,
    ): void {
        const role = message['role'] as string | undefined;

        if (role === 'human' || role === 'user') {
            const text = extractTextFromContent(message['content']);
            if (text) {
                result.prompts.push(text);
            }
        }

        if (role === 'assistant') {
            const text = extractTextFromContent(message['content']);
            if (text) {
                result.assistantMessages.push(text);
                onAssistantText(text);
            }

            // Token usage
            const usage = message['usage'] as
                | Record<string, unknown>
                | undefined;
            if (usage) {
                result.tokenUsage.inputTokens += toNumber(
                    usage['input_tokens'],
                );
                result.tokenUsage.outputTokens += toNumber(
                    usage['output_tokens'],
                );
                result.tokenUsage.cacheCreationTokens += toNumber(
                    usage['cache_creation_input_tokens'],
                );
                result.tokenUsage.cacheReadTokens += toNumber(
                    usage['cache_read_input_tokens'],
                );
                result.tokenUsage.apiCallCount++;
            }

            // Extract tool calls from content blocks
            const content = message['content'];
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (!block || typeof block !== 'object') {
                        continue;
                    }
                    const b = block as TranscriptContentBlock;

                    if (b.type !== 'tool_use' || !b.name) {
                        continue;
                    }

                    const toolName = b.name;
                    const isMcp =
                        toolName.includes('__') || toolName.startsWith('mcp_');
                    const input = b.input ?? {};
                    const filePath = input['file_path'] ?? input['filePath'];

                    // Build structured ToolCall
                    const toolCall: ToolCall = {
                        toolName,
                        toolUseId: b.id ?? '',
                        timestamp: new Date().toISOString(),
                        input: input as Record<string, unknown>,
                        isMcp,
                        mcpServer: isMcp
                            ? (toolName.split('__')[1] ??
                              toolName.split('_')[1])
                            : undefined,
                        fileAffected:
                            typeof filePath === 'string' ? filePath : undefined,
                    };
                    result.toolCalls.push(toolCall);

                    // Track modified files
                    if (
                        WRITE_TOOLS.has(toolName) &&
                        typeof filePath === 'string'
                    ) {
                        modifiedFilesSet.add(filePath);
                    }

                    // Track read files
                    if (
                        READ_TOOLS.has(toolName) &&
                        typeof filePath === 'string'
                    ) {
                        filesReadSet.add(filePath);
                    }

                    // Track bash commands
                    if (COMMAND_TOOLS.has(toolName)) {
                        const command = input['command'];
                        if (typeof command === 'string') {
                            result.commands.push(command);
                        }
                    }
                }
            }
        }
    }
}

function normalizeOffset(content: string, fromOffset: number): number {
    if (fromOffset <= 0) {
        return 0;
    }

    if (fromOffset >= content.length) {
        return content.length;
    }

    if (content[fromOffset - 1] === '\n') {
        return fromOffset;
    }

    const nextNewline = content.indexOf('\n', fromOffset);
    if (nextNewline === -1) {
        return content.length;
    }

    return nextNewline + 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }

    const texts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') {
            continue;
        }
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
            texts.push(b['text'] as string);
        }
    }
    return texts.join('\n');
}

function toNumber(value: unknown): number {
    return typeof value === 'number' ? value : 0;
}

function emptyTokenUsage(): TokenUsage {
    return {
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        apiCallCount: 0,
    };
}

export const transcriptService = new TranscriptService();
