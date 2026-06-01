import type {
    FileChange,
    TokenUsage,
    ToolCall,
    TranscriptParseResult,
} from '../types/session.js';
import {
    createEmptyTokenUsage,
    normalizeTurnParseResult,
} from './lifecycle-turn-data.js';

type TurnTranscriptData = {
    toolCalls: ToolCall[];
    filesModified: FileChange[];
    filesRead: string[];
    commands: string[];
    tokenUsage: TokenUsage;
    response: string;
};

type TranscriptServiceLike = {
    waitForFlush(transcriptPath: string, timeoutMs?: number): Promise<boolean>;
    parse(
        transcriptPath: string,
        fromOffset?: number,
    ): Promise<TranscriptParseResult>;
};

type HookLoggerLike = {
    warn(
        event: string,
        category: string,
        metadata: Record<string, unknown>,
    ): Promise<void>;
};

export function createEmptyTurnTranscriptData(): TurnTranscriptData {
    return {
        toolCalls: [],
        filesModified: [],
        filesRead: [],
        commands: [],
        tokenUsage: createEmptyTokenUsage(),
        response: '',
    };
}

export async function collectTurnTranscriptData({
    transcriptPath,
    transcriptOffset,
    transcriptService,
    hookLogger,
}: {
    transcriptPath: string;
    transcriptOffset: number;
    transcriptService: TranscriptServiceLike;
    hookLogger: HookLoggerLike;
}): Promise<TurnTranscriptData> {
    const emptyData = createEmptyTurnTranscriptData();
    const flushed = await transcriptService.waitForFlush(transcriptPath, 3000);

    if (!flushed) {
        return emptyData;
    }

    try {
        const parseResult = await transcriptService.parse(
            transcriptPath,
            transcriptOffset,
        );
        return normalizeTurnParseResult(parseResult);
    } catch (error) {
        await hookLogger.warn('transcript-parse-error', 'transcript', {
            error: error instanceof Error ? error.message : String(error),
        });
        return emptyData;
    }
}
