import { describe, it, expect } from 'vitest';
import { transcriptParserService } from '../transcript-parser.service.js';

describe('TranscriptParserService', () => {
    describe('parse', () => {
        it('returns empty signals for null/undefined', () => {
            expect(transcriptParserService.parse(null)).toEqual({
                modifiedFiles: [],
                toolUses: [],
            });
            expect(transcriptParserService.parse(undefined)).toEqual({
                modifiedFiles: [],
                toolUses: [],
            });
        });

        it('returns empty signals for non-object input', () => {
            expect(transcriptParserService.parse('string')).toEqual({
                modifiedFiles: [],
                toolUses: [],
            });
            expect(transcriptParserService.parse(42)).toEqual({
                modifiedFiles: [],
                toolUses: [],
            });
            expect(transcriptParserService.parse([1, 2])).toEqual({
                modifiedFiles: [],
                toolUses: [],
            });
        });

        it('extracts session and turn IDs', () => {
            const result = transcriptParserService.parse({
                session_id: 'sess-123',
                turn_id: 'turn-456',
            });
            expect(result.sessionId).toBe('sess-123');
            expect(result.turnId).toBe('turn-456');
        });

        it('extracts prompt and assistant message', () => {
            const result = transcriptParserService.parse({
                prompt: 'Refactor the auth module',
                last_assistant_message: 'I have refactored the auth module.',
            });
            expect(result.prompt).toBe('Refactor the auth module');
            expect(result.assistantMessage).toBe(
                'I have refactored the auth module.',
            );
        });

        it('extracts tool uses from tool_uses array', () => {
            const result = transcriptParserService.parse({
                tool_uses: [
                    { tool: 'Write', file_path: 'src/auth.ts' },
                    { tool: 'Edit', file_path: 'src/config.ts' },
                    { tool: 'Read', file_path: 'src/main.ts' },
                ],
            });
            expect(result.toolUses).toHaveLength(3);
            expect(result.toolUses[0]).toEqual({
                tool: 'Write',
                filePath: 'src/auth.ts',
                summary: undefined,
            });
            expect(result.toolUses[1]).toEqual({
                tool: 'Edit',
                filePath: 'src/config.ts',
                summary: undefined,
            });
        });

        it('extracts modified files only from Write/Edit tools', () => {
            const result = transcriptParserService.parse({
                tool_uses: [
                    { tool: 'Write', file_path: 'src/auth.ts' },
                    { tool: 'Read', file_path: 'src/main.ts' },
                    { tool: 'Edit', file_path: 'src/config.ts' },
                ],
            });
            expect(result.modifiedFiles).toEqual([
                'src/auth.ts',
                'src/config.ts',
            ]);
        });

        it('deduplicates modified files', () => {
            const result = transcriptParserService.parse({
                tool_uses: [
                    { tool: 'Write', file_path: 'src/auth.ts' },
                    { tool: 'Edit', file_path: 'src/auth.ts' },
                ],
            });
            expect(result.modifiedFiles).toEqual(['src/auth.ts']);
        });

        it('handles content blocks with tool_use type (Claude format)', () => {
            const result = transcriptParserService.parse({
                content: [
                    {
                        type: 'tool_use',
                        name: 'Write',
                        input: { file_path: 'src/new-file.ts' },
                    },
                    {
                        type: 'text',
                        text: 'some response',
                    },
                ],
            });
            expect(result.toolUses).toHaveLength(1);
            expect(result.toolUses[0]).toEqual({
                tool: 'Write',
                filePath: 'src/new-file.ts',
            });
            expect(result.modifiedFiles).toEqual(['src/new-file.ts']);
        });

        it('handles alternate key names', () => {
            const result = transcriptParserService.parse({
                'sessionId': 'alt-sess',
                'callId': 'alt-call',
                'user_message': 'hello',
                'assistant-message': 'world',
            });
            expect(result.sessionId).toBe('alt-sess');
            expect(result.turnId).toBe('alt-call');
            expect(result.prompt).toBe('hello');
            expect(result.assistantMessage).toBe('world');
        });

        it('skips malformed tool_use entries', () => {
            const result = transcriptParserService.parse({
                tool_uses: [
                    null,
                    'not-an-object',
                    { noToolName: true },
                    { tool: 'Write', file_path: 'valid.ts' },
                ],
            });
            expect(result.toolUses).toHaveLength(1);
            expect(result.toolUses[0].tool).toBe('Write');
        });

        it('returns empty signals for empty object', () => {
            const result = transcriptParserService.parse({});
            expect(result.modifiedFiles).toEqual([]);
            expect(result.toolUses).toEqual([]);
            expect(result.sessionId).toBeUndefined();
        });

        it('ignores empty/whitespace-only strings', () => {
            const result = transcriptParserService.parse({
                session_id: '  ',
                prompt: '',
            });
            expect(result.sessionId).toBeUndefined();
            expect(result.prompt).toBeUndefined();
        });
    });
});
