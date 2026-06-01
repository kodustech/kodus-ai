import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { transcriptService } from '../transcript.service.js';

describe('TranscriptService.parse', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function writeLine(obj: Record<string, unknown>): string {
        return JSON.stringify(obj);
    }

    async function writeTranscript(lines: string[]): Promise<string> {
        const filePath = path.join(tmpDir, 'transcript.jsonl');
        await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
        return filePath;
    }

    it('returns empty result for non-existent file', async () => {
        const result = await transcriptService.parse('/nonexistent/file.jsonl');
        expect(result.entryCount).toBe(0);
        expect(result.prompts).toEqual([]);
        expect(result.toolCalls).toEqual([]);
        expect(result.filesRead).toEqual([]);
        expect(result.commands).toEqual([]);
    });

    it('extracts prompts from human messages', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: { role: 'human', content: 'create a login endpoint' },
            }),
            writeLine({
                message: { role: 'human', content: 'add rate limiting' },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.prompts).toEqual([
            'create a login endpoint',
            'add rate limiting',
        ]);
    });

    it('extracts prompts from user role (flat entries)', async () => {
        const filePath = await writeTranscript([
            writeLine({ role: 'user', content: 'fix the bug' }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.prompts).toEqual(['fix the bug']);
    });

    it('extracts assistant messages and summary', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: { role: 'assistant', content: 'First response' },
            }),
            writeLine({
                message: { role: 'assistant', content: 'Second response' },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.assistantMessages).toEqual([
            'First response',
            'Second response',
        ]);
        expect(result.summary).toBe('Second response');
    });

    it('extracts token usage from assistant messages', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: 'response',
                    usage: {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 10,
                        cache_read_input_tokens: 5,
                    },
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.tokenUsage.inputTokens).toBe(100);
        expect(result.tokenUsage.outputTokens).toBe(50);
        expect(result.tokenUsage.cacheCreationTokens).toBe(10);
        expect(result.tokenUsage.cacheReadTokens).toBe(5);
        expect(result.tokenUsage.apiCallCount).toBe(1);
    });

    it('extracts modified files from Write/Edit tool_use blocks', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Write',
                            id: 'tu1',
                            input: { file_path: 'src/auth.ts' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Edit',
                            id: 'tu2',
                            input: { file_path: 'src/config.ts' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.modifiedFiles).toEqual(['src/auth.ts', 'src/config.ts']);
    });

    it('deduplicates modified files', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Write',
                            id: 'tu1',
                            input: { file_path: 'src/auth.ts' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Edit',
                            id: 'tu2',
                            input: { file_path: 'src/auth.ts' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.modifiedFiles).toEqual(['src/auth.ts']);
    });

    it('extracts structured tool calls from all tool_use blocks', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Write',
                            id: 'tu1',
                            input: { file_path: 'src/new.ts', content: 'code' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Read',
                            id: 'tu2',
                            input: { file_path: 'src/old.ts' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            id: 'tu3',
                            input: { command: 'npm test' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.toolCalls).toHaveLength(3);

        expect(result.toolCalls[0].toolName).toBe('Write');
        expect(result.toolCalls[0].toolUseId).toBe('tu1');
        expect(result.toolCalls[0].isMcp).toBe(false);
        expect(result.toolCalls[0].fileAffected).toBe('src/new.ts');

        expect(result.toolCalls[1].toolName).toBe('Read');
        expect(result.toolCalls[1].fileAffected).toBe('src/old.ts');

        expect(result.toolCalls[2].toolName).toBe('Bash');
    });

    it('extracts files read from Read/Glob/Grep tools', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Read',
                            id: 'tu1',
                            input: { file_path: 'src/auth.ts' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Grep',
                            id: 'tu2',
                            input: { file_path: 'src/', pattern: 'TODO' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Glob',
                            id: 'tu3',
                            input: { file_path: 'src/**/*.ts' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.filesRead).toContain('src/auth.ts');
        expect(result.filesRead).toContain('src/');
        expect(result.filesRead).toContain('src/**/*.ts');
    });

    it('extracts bash commands', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            id: 'tu1',
                            input: { command: 'npm test' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            id: 'tu2',
                            input: { command: 'npm run build' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.commands).toEqual(['npm test', 'npm run build']);
    });

    it('detects MCP tool calls', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'mcp__nia__search',
                            id: 'tu1',
                            input: { query: 'test' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Read',
                            id: 'tu2',
                            input: { file_path: 'src/a.ts' },
                        },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.toolCalls[0].isMcp).toBe(true);
        expect(result.toolCalls[0].mcpServer).toBe('nia');
        expect(result.toolCalls[1].isMcp).toBe(false);
        expect(result.toolCalls[1].mcpServer).toBeUndefined();
    });

    it('handles incremental parsing with fromOffset', async () => {
        const line1 = writeLine({
            message: { role: 'human', content: 'first prompt' },
        });
        const line2 = writeLine({
            message: { role: 'human', content: 'second prompt' },
        });
        const filePath = await writeTranscript([line1, line2]);

        const offset = line1.length + 1; // +1 for newline
        const result = await transcriptService.parse(filePath, offset);
        expect(result.prompts).toEqual(['second prompt']);
    });

    it('skips the partial line when fromOffset starts mid-line', async () => {
        const line1 = writeLine({
            message: { role: 'human', content: 'first prompt' },
        });
        const line2 = writeLine({
            message: { role: 'human', content: 'second prompt' },
        });
        const filePath = await writeTranscript([line1, line2]);

        const offset = Math.floor(line1.length / 2);
        const result = await transcriptService.parse(filePath, offset);

        expect(result.prompts).toEqual(['second prompt']);
        expect(result.entryCount).toBe(1);
    });

    it('skips malformed JSON lines', async () => {
        const filePath = await writeTranscript([
            'not json at all',
            writeLine({ message: { role: 'human', content: 'valid prompt' } }),
            '{ broken json',
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.prompts).toEqual(['valid prompt']);
        expect(result.entryCount).toBe(1);
    });

    it('tracks subagent IDs', async () => {
        const filePath = await writeTranscript([
            writeLine({
                subagent_id: 'sub-1',
                message: { role: 'assistant', content: 'response' },
            }),
            writeLine({
                subagent_id: 'sub-2',
                message: { role: 'assistant', content: 'response' },
            }),
            writeLine({
                subagent_id: 'sub-1',
                message: { role: 'assistant', content: 'another' },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.subagentIds).toHaveLength(2);
        expect(result.subagentIds).toContain('sub-1');
        expect(result.subagentIds).toContain('sub-2');
    });

    it('handles content as array of text blocks', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'part one' },
                        { type: 'text', text: 'part two' },
                    ],
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);
        expect(result.assistantMessages).toEqual(['part one\npart two']);
    });

    it('handles a full realistic transcript', async () => {
        const filePath = await writeTranscript([
            writeLine({
                message: { role: 'human', content: 'create a login endpoint' },
            }),
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'text',
                            text: 'I will create the login endpoint.',
                        },
                        {
                            type: 'tool_use',
                            name: 'Read',
                            id: 'r1',
                            input: { file_path: 'src/routes.ts' },
                        },
                    ],
                    usage: { input_tokens: 500, output_tokens: 100 },
                },
            }),
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Write',
                            id: 'w1',
                            input: { file_path: 'src/auth.ts', content: '...' },
                        },
                        {
                            type: 'tool_use',
                            name: 'Edit',
                            id: 'e1',
                            input: {
                                file_path: 'src/routes.ts',
                                old_string: '...',
                                new_string: '...',
                            },
                        },
                    ],
                    usage: { input_tokens: 800, output_tokens: 200 },
                },
            }),
            writeLine({
                message: {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            id: 'b1',
                            input: { command: 'npm test' },
                        },
                    ],
                    usage: { input_tokens: 300, output_tokens: 50 },
                },
            }),
            writeLine({
                message: {
                    role: 'assistant',
                    content: 'All tests pass. The login endpoint is ready.',
                    usage: { input_tokens: 200, output_tokens: 30 },
                },
            }),
        ]);

        const result = await transcriptService.parse(filePath);

        expect(result.prompts).toEqual(['create a login endpoint']);
        expect(result.modifiedFiles).toEqual(['src/auth.ts', 'src/routes.ts']);
        expect(result.filesRead).toEqual(['src/routes.ts']);
        expect(result.commands).toEqual(['npm test']);
        expect(result.toolCalls).toHaveLength(4);
        expect(result.summary).toBe(
            'All tests pass. The login endpoint is ready.',
        );
        expect(result.tokenUsage.inputTokens).toBe(1800);
        expect(result.tokenUsage.outputTokens).toBe(380);
        expect(result.tokenUsage.apiCallCount).toBe(4);
    });
});
