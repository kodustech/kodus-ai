import type {
    FileChange,
    TokenUsage,
    ToolCall,
    TranscriptParseResult,
} from '../types/session.js';

export function createEmptyTokenUsage(): TokenUsage {
    return {
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        apiCallCount: 0,
    };
}

export function normalizeTurnParseResult(parseResult: TranscriptParseResult): {
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    response: string;
} {
    return {
        toolCalls: parseResult.toolCalls,
        filesModified: parseResult.modifiedFiles.map((path) => ({
            path,
            action: 'modified' as const,
        })),
        filesRead: parseResult.filesRead,
        commands: parseResult.commands,
        tokenUsage: parseResult.tokenUsage,
        response: parseResult.assistantMessages.join('\n\n'),
    };
}
