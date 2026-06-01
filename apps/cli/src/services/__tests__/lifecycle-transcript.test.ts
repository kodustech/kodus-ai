import { describe, expect, it, vi } from 'vitest';
import type { TranscriptParseResult } from '../../types/session.js';
import { collectTurnTranscriptData } from '../lifecycle-transcript.js';

function createParseResult(
    overrides: Partial<TranscriptParseResult> = {},
): TranscriptParseResult {
    return {
        prompts: [],
        assistantMessages: ['Applied fix'],
        modifiedFiles: ['src/auth.ts'],
        tokenUsage: {
            inputTokens: 10,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 5,
            apiCallCount: 1,
        },
        summary: 'Applied fix',
        subagentIds: [],
        entryCount: 1,
        toolCalls: [],
        filesRead: ['src/auth.ts'],
        commands: ['npm test'],
        ...overrides,
    };
}

describe('collectTurnTranscriptData', () => {
    it('returns normalized transcript data when the transcript flushes', async () => {
        const transcript = {
            waitForFlush: vi.fn().mockResolvedValue(true),
            parse: vi.fn().mockResolvedValue(createParseResult()),
        };
        const logger = {
            warn: vi.fn().mockResolvedValue(undefined),
        };

        const result = await collectTurnTranscriptData({
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 123,
            transcriptService: transcript,
            hookLogger: logger,
        });

        expect(transcript.waitForFlush).toHaveBeenCalledWith(
            '/tmp/transcript.jsonl',
            3000,
        );
        expect(transcript.parse).toHaveBeenCalledWith(
            '/tmp/transcript.jsonl',
            123,
        );
        expect(result).toEqual({
            toolCalls: [],
            filesModified: [{ path: 'src/auth.ts', action: 'modified' }],
            filesRead: ['src/auth.ts'],
            commands: ['npm test'],
            tokenUsage: {
                inputTokens: 10,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 5,
                apiCallCount: 1,
            },
            response: 'Applied fix',
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('returns empty transcript data when the transcript does not flush', async () => {
        const transcript = {
            waitForFlush: vi.fn().mockResolvedValue(false),
            parse: vi.fn(),
        };
        const logger = {
            warn: vi.fn().mockResolvedValue(undefined),
        };

        const result = await collectTurnTranscriptData({
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 123,
            transcriptService: transcript,
            hookLogger: logger,
        });

        expect(transcript.parse).not.toHaveBeenCalled();
        expect(result).toEqual({
            toolCalls: [],
            filesModified: [],
            filesRead: [],
            commands: [],
            tokenUsage: {
                inputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 0,
                apiCallCount: 0,
            },
            response: '',
        });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('returns empty transcript data and warns when parsing fails', async () => {
        const transcript = {
            waitForFlush: vi.fn().mockResolvedValue(true),
            parse: vi.fn().mockRejectedValue(new Error('bad transcript')),
        };
        const logger = {
            warn: vi.fn().mockResolvedValue(undefined),
        };

        const result = await collectTurnTranscriptData({
            transcriptPath: '/tmp/transcript.jsonl',
            transcriptOffset: 123,
            transcriptService: transcript,
            hookLogger: logger,
        });

        expect(result).toEqual({
            toolCalls: [],
            filesModified: [],
            filesRead: [],
            commands: [],
            tokenUsage: {
                inputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                outputTokens: 0,
                apiCallCount: 0,
            },
            response: '',
        });
        expect(logger.warn).toHaveBeenCalledWith(
            'transcript-parse-error',
            'transcript',
            { error: 'bad transcript' },
        );
    });
});
