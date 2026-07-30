/**
 * buildFinderToolRegistry unit tests — deterministic, no sandbox/LLM.
 * Mocks buildAgentTools to assert the adapter MAPPING:
 *  - recovers raw JSON schema from the jsonSchema() wrapper
 *  - maps execute(args)->string into execute(input,ctx)->ToolResult
 *  - turns thrown errors into {isError:true} values (no crash)
 */
import { jsonSchema } from 'ai';

jest.mock('../engine/agent-tools.factory', () => ({
    buildAgentTools: jest.fn(),
}));

import { buildAgentTools } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import { buildFinderToolRegistry } from '@libs/code-review/infrastructure/agents/adapters/finder-tools.adapter';

const ctx = { runId: 'r' } as any;

describe('buildFinderToolRegistry', () => {
    it('wraps tools, recovers raw schema, and maps output to ToolResult', async () => {
        (buildAgentTools as jest.Mock).mockReturnValue({
            grep: {
                description: 'search the repo',
                inputSchema: jsonSchema({
                    type: 'object',
                    properties: { pattern: { type: 'string' } },
                    required: ['pattern'],
                }),
                execute: async (a: any) => `matched ${a.pattern}`,
            },
        });

        const { registry: reg } = buildFinderToolRegistry({
            remoteCommands: undefined,
        });
        const grep = reg.get('grep')!;

        expect(grep.name).toBe('grep');
        expect(grep.description).toBe('search the repo');
        // raw schema recovered (not the wrapper object)
        expect(grep.inputSchema.required).toEqual(['pattern']);
        expect(grep.inputSchema.properties?.pattern.type).toBe('string');

        const r = await grep.execute({ pattern: 'foo' }, ctx);
        expect(r.output).toBe('matched foo');
        expect(r.isError).toBeFalsy();
    });

    it('turns thrown tool errors into isError results (loop recovers)', async () => {
        (buildAgentTools as jest.Mock).mockReturnValue({
            readFile: {
                description: 'read a file',
                inputSchema: jsonSchema({ type: 'object', properties: {} }),
                execute: async () => {
                    throw new Error('file not found');
                },
            },
        });

        const { registry: reg } = buildFinderToolRegistry({
            remoteCommands: undefined,
        });
        const r = await reg.get('readFile')!.execute({}, ctx);
        expect(r.isError).toBe(true);
        expect(r.output).toContain('file not found');
    });

    it('memoizes read-only tools — an identical call is served from cache', async () => {
        let calls = 0;
        (buildAgentTools as jest.Mock).mockReturnValue({
            grep: {
                description: 'search',
                inputSchema: jsonSchema({ type: 'object', properties: {} }),
                execute: async () => `result ${++calls}`,
            },
        });

        const { registry: reg, cache } = buildFinderToolRegistry({
            remoteCommands: undefined,
        });
        const grep = reg.get('grep')!;

        const first = await grep.execute({ pattern: 'x' }, ctx);
        const second = await grep.execute({ pattern: 'x' }, ctx);

        expect(calls).toBe(1); // inner ran once
        expect(first.output).toBe('result 1');
        expect(second.meta?.cached).toBe(true);
        expect(cache.stats.hits).toBe(1);
    });
});
