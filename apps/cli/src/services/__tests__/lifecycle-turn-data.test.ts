import { describe, expect, it } from 'vitest';
import type { TranscriptParseResult } from '../../types/session.js';
import {
    createEmptyTokenUsage,
    normalizeTurnParseResult,
} from '../lifecycle-turn-data.js';

describe('createEmptyTokenUsage', () => {
    it('returns the zeroed token usage payload', () => {
        expect(createEmptyTokenUsage()).toEqual({
            inputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            apiCallCount: 0,
        });
    });
});

describe('normalizeTurnParseResult', () => {
    it('maps transcript parse data to turn-end fields', () => {
        const parseResult: TranscriptParseResult = {
            prompts: ['prompt'],
            assistantMessages: ['part one', 'part two'],
            modifiedFiles: ['src/auth.ts', 'src/config.ts'],
            tokenUsage: {
                inputTokens: 10,
                cacheCreationTokens: 1,
                cacheReadTokens: 2,
                outputTokens: 20,
                apiCallCount: 3,
            },
            summary: 'summary',
            subagentIds: [],
            entryCount: 5,
            toolCalls: [
                {
                    toolName: 'Write',
                    toolUseId: 'tool-1',
                    timestamp: '2026-03-14T00:00:00.000Z',
                    input: { file_path: 'src/auth.ts' },
                    isMcp: false,
                    fileAffected: 'src/auth.ts',
                },
            ],
            filesRead: ['src/old.ts'],
            commands: ['npm test'],
        };

        expect(normalizeTurnParseResult(parseResult)).toEqual({
            toolCalls: parseResult.toolCalls,
            filesModified: [
                { path: 'src/auth.ts', action: 'modified' },
                { path: 'src/config.ts', action: 'modified' },
            ],
            filesRead: ['src/old.ts'],
            commands: ['npm test'],
            tokenUsage: parseResult.tokenUsage,
            response: 'part one\n\npart two',
        });
    });
});
