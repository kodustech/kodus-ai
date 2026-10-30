import { tool } from 'ai';
import { z } from 'zod';

import {
    auditWriteTools,
    isConversationWriteTool,
    writeToolPredicate,
    type WriteToolEvent,
} from './conversation-tool-audit';

const stub = (result: string, fail = false) =>
    tool({
        description: 'stub',
        inputSchema: z.object({}),
        execute: async () => {
            if (fail) {
                throw new Error('boom');
            }
            return result;
        },
    });

describe('auditWriteTools', () => {
    it('reports a write tool call and forwards its result', async () => {
        const seen: Array<{ tool: string; args: unknown }> = [];
        const tools = auditWriteTools(
            { KODUS_CREATE_MEMORY: stub('created') },
            { KODUS_CREATE_MEMORY: { readOnlyHint: false } },
            (e) => seen.push(e),
        );

        await expect(
            tools.KODUS_CREATE_MEMORY.execute!({ title: 'x' }, {} as any),
        ).resolves.toBe('created');
        expect(seen).toEqual([
            {
                tool: 'KODUS_CREATE_MEMORY',
                args: { title: 'x' },
                result: 'created',
            },
        ]);
    });

    it('reports a write that failed and lets the error through', async () => {
        const seen: Array<{ tool: string; error?: string }> = [];
        const tools = auditWriteTools(
            { KODUS_UPDATE_KODY_RULE: stub('', true) },
            { KODUS_UPDATE_KODY_RULE: { readOnlyHint: false } },
            (e) => seen.push(e),
        );

        await expect(
            tools.KODUS_UPDATE_KODY_RULE.execute!({}, {} as any),
        ).rejects.toThrow('boom');
        expect(seen[0].error).toBe('boom');
    });

    it('leaves the sandbox tools out of the write path entirely', async () => {
        const seen: WriteToolEvent[] = [];
        // grep/readFile/listDir/exec are built locally, not served over MCP, so
        // they carry no annotations — that absence must not read as "a write".
        const tools = auditWriteTools({ grep: stub('matches') }, {}, (e) =>
            seen.push(e),
        );

        await tools.grep.execute!({}, {} as any);

        expect(seen).toHaveLength(0);
    });

    it('leaves read tools untouched', () => {
        const read = stub('memories');
        const tools = auditWriteTools(
            { KODUS_FIND_MEMORIES: read },
            { KODUS_FIND_MEMORIES: { readOnlyHint: true } },
            () => {},
        );

        expect(tools.KODUS_FIND_MEMORIES).toBe(read);
    });

    it('reads write-ness off the tool, destructive ones included', () => {
        expect(isConversationWriteTool({ readOnlyHint: false })).toBe(true);
        expect(
            isConversationWriteTool({
                readOnlyHint: false,
                destructiveHint: true,
            }),
        ).toBe(true);
        expect(isConversationWriteTool({ readOnlyHint: true })).toBe(false);
    });

    it('still audits an MCP tool that declares nothing', async () => {
        const seen: WriteToolEvent[] = [];
        // Present in the metadata map but with no annotations — a third-party
        // server that told us nothing. Assume it writes.
        const tools = auditWriteTools(
            { SOME_THIRD_PARTY_TOOL: stub('ok') },
            { SOME_THIRD_PARTY_TOOL: {} },
            (e) => seen.push(e),
        );

        await tools.SOME_THIRD_PARTY_TOOL.execute!({}, {} as any);

        expect(seen).toHaveLength(1);
    });

    it('names a tool a write only when MCP served it', () => {
        const isWrite = writeToolPredicate({
            KODUS_CREATE_MEMORY: { readOnlyHint: false },
            KODUS_FIND_MEMORIES: { readOnlyHint: true },
            SOME_THIRD_PARTY_TOOL: {},
        });

        expect(isWrite('KODUS_CREATE_MEMORY')).toBe(true);
        expect(isWrite('KODUS_FIND_MEMORIES')).toBe(false);
        expect(isWrite('SOME_THIRD_PARTY_TOOL')).toBe(true);
        expect(isWrite('grep')).toBe(false);
    });
});
