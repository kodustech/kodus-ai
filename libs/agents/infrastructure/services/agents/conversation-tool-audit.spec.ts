import { tool } from 'ai';
import { z } from 'zod';

import {
    auditWriteTools,
    isConversationWriteTool,
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
            (e) => seen.push(e),
        );

        await expect(
            tools.KODUS_CREATE_MEMORY.execute!({ title: 'x' }, {} as any),
        ).resolves.toBe('created');
        expect(seen).toEqual([
            { tool: 'KODUS_CREATE_MEMORY', args: { title: 'x' } },
        ]);
    });

    it('reports a write that failed and lets the error through', async () => {
        const seen: Array<{ tool: string; error?: string }> = [];
        const tools = auditWriteTools(
            { KODUS_UPDATE_KODY_RULE: stub('', true) },
            (e) => seen.push(e),
        );

        await expect(
            tools.KODUS_UPDATE_KODY_RULE.execute!({}, {} as any),
        ).rejects.toThrow('boom');
        expect(seen[0].error).toBe('boom');
    });

    it('leaves read tools untouched', () => {
        const read = stub('memories');
        const tools = auditWriteTools({ KODUS_FIND_MEMORIES: read }, () => {});

        expect(tools.KODUS_FIND_MEMORIES).toBe(read);
    });

    it('counts every mutating Kodus tool as a write, including the destructive ones', () => {
        expect(isConversationWriteTool('KODUS_CREATE_MEMORY')).toBe(true);
        expect(isConversationWriteTool('KODUS_DELETE_KODY_RULE')).toBe(true);
        expect(isConversationWriteTool('KODUS_DELETE_KODY_ISSUE')).toBe(true);
        expect(isConversationWriteTool('KODUS_FIND_MEMORIES')).toBe(false);
        expect(isConversationWriteTool('grep')).toBe(false);
    });
});
