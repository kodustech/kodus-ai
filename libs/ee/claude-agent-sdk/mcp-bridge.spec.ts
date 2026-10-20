import { jsonSchema, tool as aiTool } from 'ai';

import { buildAgentTools } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import { submitResultTool } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { buildNativeTools } from '@libs/agents/infrastructure/services/ai-sdk/native-tools';

import { loadSdkRuntime } from './sdk-runtime';
import { bareName, mcpName, shapeOf, toMcpServer } from './mcp-bridge';

const remote = {
    grep: async (pattern: string, path: string) => `${path}:1:${pattern}`,
    read: async (path: string, start: number, end: number) => `${path} ${start}-${end}`,
    listDir: async (path: string) => `${path}/a.ts`,
    exec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
} as any;

// The finder's result tool as the runner converts an AgentTool for the AI SDK.
const finderSubmit = aiTool({ description: submitResultTool.description, inputSchema: jsonSchema(submitResultTool.inputSchema as any), execute: async () => 'recorded' });

describe('toMcpServer', () => {
    const rt = loadSdkRuntime();

    it('exposes the finder’s real tools under MCP names, each with a shape that accepts what the AI SDK schema accepts', async () => {
        const tools = { ...buildAgentTools(remote), submitResult: finderSubmit };
        const { names, defs } = toMcpServer(rt, tools as any);
        expect(names).toEqual(Object.keys(tools).map(mcpName));
        expect(names).toContain('mcp__kodus__readFile');
        expect(names).toContain('mcp__kodus__submitResult');
        const read = defs.find((d) => d.name === 'readFile')!;
        expect(rt.z.object(read.inputSchema).safeParse({ path: 'a.ts', startLine: 1, endLine: 20 }).success).toBe(true);
        expect(rt.z.object(read.inputSchema).safeParse({ startLine: 1 }).success).toBe(false);
        const submit = defs.find((d) => d.name === 'submitResult')!;
        const finding = { relevantFile: 'a.ts', suggestionContent: 'c', existingCode: 'x', improvedCode: 'y', oneSentenceSummary: 's', label: 'bug' };
        expect(rt.z.object(submit.inputSchema).safeParse({ reasoning: 'r', suggestions: [finding] }).success).toBe(true);
        expect(rt.z.object(submit.inputSchema).safeParse({ reasoning: 'r', suggestions: [{ ...finding, label: 'style' }] }).success).toBe(false);
    });

    it('runs a tool in this process and returns its output as MCP text', async () => {
        const { defs } = toMcpServer(rt, buildAgentTools(remote) as any);
        const out = await defs.find((d) => d.name === 'readFile')!.handler({ path: 'src/a.ts', startLine: 1, endLine: 5 });
        expect(out.isError).toBeUndefined();
        expect(out.content[0].type).toBe('text');
        expect(out.content[0].text).toContain('src/a.ts');
    });

    it('bridges the agents’ native tools (zod schemas) the same way', async () => {
        const tools = buildNativeTools({ type: 'e2b', remoteCommands: remote } as any);
        const { names, defs } = toMcpServer(rt, tools as any);
        expect(names).toEqual(Object.keys(tools).map(mcpName));
        const grep = defs.find((d) => d.name === 'grep')!;
        expect(rt.z.object(grep.inputSchema).safeParse({ pattern: 'foo' }).success).toBe(true);
        expect((await grep.handler({ pattern: 'foo' })).content[0].text).toContain('foo');
    });

    it('turns a thrown tool error into an MCP error result, never a crash', async () => {
        const boom = aiTool({ description: 'b', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async (): Promise<string> => { throw new Error('sandbox gone'); } } as any);
        const { defs } = toMcpServer(rt, { boom } as any);
        expect(await defs[0].handler({})).toEqual({ content: [{ type: 'text', text: 'Tool error: sandbox gone' }], isError: true });
    });

    it('serializes an object output as JSON text', async () => {
        const obj = aiTool({ description: 'o', inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: async () => ({ a: 1 }) });
        expect((await toMcpServer(rt, { obj } as any).defs[0].handler({})).content[0].text).toBe('{"a":1}');
    });

    it('falls back to a permissive shape for a schema zod cannot convert, keeping the declared fields', () => {
        const weird = { type: 'object', properties: { a: { description: 'first' }, b: { $ref: '#/nowhere' } }, required: ['a'] };
        const shape = shapeOf({ ...rt.z, fromJSONSchema: () => { throw new Error('unsupported'); } }, weird);
        expect(Object.keys(shape)).toEqual(['a', 'b']);
        expect(rt.z.object(shape).safeParse({ a: 1, b: { x: 2 } }).success).toBe(true);
    });

    it('skips entries without execute and maps names both ways', () => {
        expect(toMcpServer(rt, { noop: { description: 'x' } } as any).names).toEqual([]);
        expect(bareName('mcp__kodus__grep')).toBe('grep');
        expect(bareName('StructuredOutput')).toBe('StructuredOutput');
    });
});
