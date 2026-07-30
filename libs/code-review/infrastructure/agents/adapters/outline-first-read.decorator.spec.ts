import type {
    AgentTool,
    ToolContext,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { OutlineFirstReadTool } from './outline-first-read.decorator';

const ctx = { runId: 'r' } as ToolContext;

/** Spy readFile that counts how often it's delegated to, echoing the input. */
function innerReadFile(): { tool: AgentTool; calls: () => number } {
    let count = 0;
    const tool: AgentTool = {
        name: 'readFile',
        description: 'read',
        inputSchema: { type: 'object', properties: {} },
        execute: async (input) => {
            count++;
            return { output: `INNER:${JSON.stringify(input)}` };
        },
    };
    return { tool, calls: () => count };
}

const bigCode = Array.from(
    { length: 300 },
    (_, i) =>
        i === 10
            ? 'export function alpha() {'
            : i === 120
              ? 'export class Beta {'
              : `  const x${i} = ${i};`,
).join('\n');

describe('OutlineFirstReadTool', () => {
    it('returns a symbol outline for a range-less read of a large file', async () => {
        const inner = innerReadFile();
        const tool = new OutlineFirstReadTool(inner.tool, {
            readFull: async () => bigCode,
            minLines: 150,
        });

        const r = await tool.execute({ path: 'big.ts' }, ctx);

        expect(r.meta?.outlineFirst).toBe(true);
        expect(r.output).toContain('Outline of big.ts');
        expect(r.output).toContain('11: export function alpha()'); // 1-based line
        expect(r.output).toContain('121: export class Beta');
        expect(inner.calls()).toBe(0); // did NOT dump the file via inner
    });

    it('honors an explicit range — delegates untouched', async () => {
        const inner = innerReadFile();
        let readFullCalled = false;
        const tool = new OutlineFirstReadTool(inner.tool, {
            readFull: async () => {
                readFullCalled = true;
                return bigCode;
            },
        });

        const r = await tool.execute(
            { path: 'big.ts', startLine: 10, endLine: 40 },
            ctx,
        );

        expect(inner.calls()).toBe(1);
        expect(r.output).toContain('INNER:');
        expect(readFullCalled).toBe(false); // didn't even read for an outline
    });

    it('delegates for a small file (<= minLines)', async () => {
        const inner = innerReadFile();
        const tool = new OutlineFirstReadTool(inner.tool, {
            readFull: async () => 'export function tiny() {}\n',
            minLines: 150,
        });

        const r = await tool.execute({ path: 'tiny.ts' }, ctx);

        expect(inner.calls()).toBe(1);
        expect(r.output).toContain('INNER:');
    });

    it('delegates when the file has no recognizable symbols', async () => {
        const inner = innerReadFile();
        const data = Array.from({ length: 300 }, (_, i) => `row ${i},value`).join(
            '\n',
        );
        const tool = new OutlineFirstReadTool(inner.tool, {
            readFull: async () => data,
            minLines: 150,
        });

        const r = await tool.execute({ path: 'data.csv' }, ctx);

        expect(inner.calls()).toBe(1);
        expect(r.output).toContain('INNER:');
    });

    it('delegates when the full read fails', async () => {
        const inner = innerReadFile();
        const tool = new OutlineFirstReadTool(inner.tool, {
            readFull: async () => {
                throw new Error('boom');
            },
        });

        const r = await tool.execute({ path: 'gone.ts' }, ctx);

        expect(inner.calls()).toBe(1);
        expect(r.output).toContain('INNER:');
    });
});
