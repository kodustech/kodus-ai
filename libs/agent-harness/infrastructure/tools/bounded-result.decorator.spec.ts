import type {
    AgentTool,
    ToolContext,
    ToolResult,
} from '../../domain/contracts/tool.contract';
import {
    BoundedResultStore,
    BoundedResultTool,
    makeFetchResultTool,
} from './bounded-result.decorator';

const ctx = { runId: 'r1' } as ToolContext;

/** A tool that returns a fixed output (and counts executions). */
function toolReturning(
    name: string,
    output: string | ((input: any) => ToolResult),
): { tool: AgentTool; calls: () => number } {
    let count = 0;
    const tool: AgentTool = {
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        execute: async (input) => {
            count++;
            return typeof output === 'string' ? { output } : output(input);
        },
    };
    return { tool, calls: () => count };
}

/** N lines of the form `<prefix> <i>`. */
function lines(n: number, prefix = 'line'): string {
    return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

describe('BoundedResultTool', () => {
    it('passes small outputs through untouched', async () => {
        const { tool } = toolReturning('grep', 'a\nb\nc');
        const store = new BoundedResultStore();
        const bounded = new BoundedResultTool(tool, store, { maxChars: 100 });

        const r = await bounded.execute({ pattern: 'x' }, ctx);

        expect(r.output).toBe('a\nb\nc');
        expect(r.meta?.bounded).toBeUndefined();
        expect(store.stats.size).toBe(0);
    });

    it('bounds an oversized output: preview + handle + meta, full body stored', async () => {
        const full = lines(200); // ~1.6k chars
        const { tool } = toolReturning('grep', full);
        const store = new BoundedResultStore();
        const bounded = new BoundedResultTool(tool, store, {
            maxChars: 200,
            previewLines: 5,
        });

        const r = await bounded.execute({ pattern: 'x' }, ctx);

        // Preview shows only the head, not the flood.
        expect(r.output).toContain('line 1');
        expect(r.output).toContain('line 5');
        expect(r.output).not.toContain('line 6');
        expect(r.output).toContain('195 more line(s) not shown');
        // Handle surfaced to the model + in meta.
        expect(r.meta?.bounded).toBe(true);
        expect(r.meta?.handle).toBe('grep#1');
        expect(r.meta?.fullChars).toBe(full.length);
        expect(r.output).toContain('grep#1');
        // Full body is retrievable from the store.
        expect(store.get('r1', 'grep#1')).toBe(full);
        expect(store.stats.bounded).toBe(1);
    });

    it('handles increment per tool and scope by runId', async () => {
        const { tool } = toolReturning('grep', lines(100));
        const store = new BoundedResultStore();
        const bounded = new BoundedResultTool(tool, store, { maxChars: 50 });

        const a = await bounded.execute({ pattern: '1' }, { runId: 'rA' } as ToolContext);
        const b = await bounded.execute({ pattern: '2' }, { runId: 'rA' } as ToolContext);
        const c = await bounded.execute({ pattern: '3' }, { runId: 'rB' } as ToolContext);

        expect(a.meta?.handle).toBe('grep#1');
        expect(b.meta?.handle).toBe('grep#2'); // increments within a run
        expect(c.meta?.handle).toBe('grep#1'); // fresh counter for a new run
    });

    it('never bounds an error — it reaches the model verbatim', async () => {
        const { tool } = toolReturning('grep', () => ({
            output: lines(500), // huge, but…
            isError: true, // …an error must pass through
        }));
        const store = new BoundedResultStore();
        const bounded = new BoundedResultTool(tool, store, { maxChars: 100 });

        const r = await bounded.execute({ pattern: 'x' }, ctx);

        expect(r.isError).toBe(true);
        expect(r.meta?.bounded).toBeUndefined();
        expect(store.stats.bounded).toBe(0);
    });

    it('uses a domain summarize hook when provided', async () => {
        const full = lines(300);
        const { tool } = toolReturning('grep', full);
        const store = new BoundedResultStore();
        const bounded = new BoundedResultTool(tool, store, {
            maxChars: 100,
            summarize: () => '3 files, 300 matches (grouped)',
        });

        const r = await bounded.execute({ pattern: 'x' }, ctx);

        expect(r.output).toContain('3 files, 300 matches (grouped)');
        expect(r.output).not.toContain('line 1'); // head replaced by summary
        expect(r.meta?.handle).toBe('grep#1');
    });
});

describe('makeFetchResultTool', () => {
    /** Bound a body and return the fetch tool + the handle. */
    async function boundBody(
        full: string,
        runId = 'r1',
    ): Promise<{ store: BoundedResultStore; fetch: AgentTool; handle: string }> {
        const store = new BoundedResultStore();
        const { tool } = toolReturning('grep', full);
        const bounded = new BoundedResultTool(tool, store, { maxChars: 10 });
        const r = await bounded.execute(
            { pattern: 'x' },
            { runId } as ToolContext,
        );
        return { store, fetch: makeFetchResultTool(store), handle: r.meta!.handle as string };
    }

    it('pages a slice with offset/limit', async () => {
        const { fetch, handle } = await boundBody(lines(200));

        const r = await fetch.execute({ handle, offset: 10, limit: 3 }, ctx);

        expect(r.isError).toBeUndefined();
        expect(r.output).toContain('line 11');
        expect(r.output).toContain('line 13');
        expect(r.output).not.toContain('line 14');
        expect(r.output).toContain('of 200');
        expect(r.output).toContain('more matching line(s)');
    });

    it('filters with grep before paging', async () => {
        const body = ['auth.ts: bug', 'api.ts: ok', 'auth.ts: race', 'db.ts: ok'].join('\n');
        const { fetch, handle } = await boundBody(body);

        const r = await fetch.execute({ handle, grep: 'auth\\.ts' }, ctx);

        expect(r.output).toContain('auth.ts: bug');
        expect(r.output).toContain('auth.ts: race');
        expect(r.output).not.toContain('api.ts');
        expect(r.output).toContain('of 2'); // filtered total
    });

    it('falls back to substring when grep is not a valid regex', async () => {
        const body = ['a(b', 'ccc', 'a(b again'].join('\n');
        const { fetch, handle } = await boundBody(body);

        const r = await fetch.execute({ handle, grep: 'a(b' }, ctx); // invalid regex

        expect(r.output).toContain('a(b');
        expect(r.output).not.toContain('ccc');
    });

    it('errors on an unknown handle', async () => {
        const { fetch } = await boundBody(lines(50));

        const r = await fetch.execute({ handle: 'grep#999' }, ctx);

        expect(r.isError).toBe(true);
        expect(r.output).toContain('unknown handle');
    });

    it('errors when handle is missing', async () => {
        const { fetch } = await boundBody(lines(50));

        const r = await fetch.execute({}, ctx);

        expect(r.isError).toBe(true);
        expect(r.output).toContain('missing');
    });

    it('scopes handles by run — a handle from run A is invisible to run B', async () => {
        const { store, handle } = await boundBody(lines(50), 'runA');
        const fetch = makeFetchResultTool(store);

        const sameRun = await fetch.execute({ handle }, { runId: 'runA' } as ToolContext);
        const crossRun = await fetch.execute({ handle }, { runId: 'runB' } as ToolContext);

        expect(sameRun.isError).toBeUndefined();
        expect(crossRun.isError).toBe(true); // never crosses runs
    });
});
