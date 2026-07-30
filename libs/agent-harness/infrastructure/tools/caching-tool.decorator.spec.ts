import type {
    AgentTool,
    ToolContext,
    ToolResult,
} from '../../domain/contracts/tool.contract';
import { CachingTool, ToolCallCache, withRunCache } from './caching-tool.decorator';

const ctx = { runId: 'r1' } as ToolContext;

/** A spy tool that counts executions and echoes its input. */
function spyTool(
    name: string,
    impl: (input: any) => ToolResult = (input) => ({
        output: `${name}:${JSON.stringify(input)}`,
    }),
): { tool: AgentTool; calls: () => number } {
    let count = 0;
    const tool: AgentTool = {
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        execute: async (input) => {
            count++;
            return impl(input);
        },
    };
    return { tool, calls: () => count };
}

describe('CachingTool', () => {
    it('executes once, then serves identical calls from cache without re-running', async () => {
        const { tool, calls } = spyTool('readFile');
        const cached = new CachingTool(tool, new ToolCallCache());

        const first = await cached.execute({ path: 'a.ts', startLine: 1 }, ctx);
        const second = await cached.execute({ path: 'a.ts', startLine: 1 }, ctx);

        expect(calls()).toBe(1); // inner ran only once
        expect(first.output).toContain('readFile:');
        expect(second.meta?.cached).toBe(true);
        // Re-serves the FULL body (safe under context compression), not a pointer.
        expect(second.output).toEqual(first.output);
    });

    it('a cache hit re-serves the full body + preserves the inner meta (compression-safe)', async () => {
        // Regression guard: a "see above" pointer would dangle once the context
        // compressor truncates the earlier copy. The hit must return the whole
        // body so the agent never loses data it re-requested on a long run.
        const tool = spyTool('readFile', () => ({
            output: 'L1\nL2\nL3\n…full file body…',
            meta: { outlineFirst: true, lines: 1200 },
        })).tool;
        const cached = new CachingTool(tool, new ToolCallCache());

        const first = await cached.execute({ path: 'big.ts' }, ctx);
        const hit = await cached.execute({ path: 'big.ts' }, ctx);

        expect(hit.output).toBe(first.output); // full body, not a stub
        expect(hit.meta).toEqual({
            outlineFirst: true,
            lines: 1200,
            cached: true, // inner meta preserved + cached flag added
        });
    });

    it('re-runs when the input differs', async () => {
        const { tool, calls } = spyTool('grep');
        const cached = new CachingTool(tool, new ToolCallCache());

        await cached.execute({ pattern: 'foo' }, ctx);
        await cached.execute({ pattern: 'bar' }, ctx);

        expect(calls()).toBe(2);
    });

    it('keys are order-insensitive ({a,b} === {b,a})', async () => {
        const { tool, calls } = spyTool('listDir');
        const cached = new CachingTool(tool, new ToolCallCache());

        await cached.execute({ path: '.', maxDepth: 2 }, ctx);
        const hit = await cached.execute({ maxDepth: 2, path: '.' }, ctx);

        expect(calls()).toBe(1);
        expect(hit.meta?.cached).toBe(true);
    });

    it('never caches errors — a retry re-runs the tool', async () => {
        let attempt = 0;
        const tool: AgentTool = {
            name: 'flaky',
            description: 'flaky',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => {
                attempt++;
                return attempt === 1
                    ? { output: 'boom', isError: true }
                    : { output: 'ok' };
            },
        };
        const cached = new CachingTool(tool, new ToolCallCache());

        const failed = await cached.execute({ path: 'x' }, ctx);
        const retried = await cached.execute({ path: 'x' }, ctx);

        expect(failed.isError).toBe(true);
        expect(retried.output).toBe('ok'); // re-ran instead of returning cached error
    });

    it('scopes by runId — a shared cache never crosses runs', async () => {
        const { tool, calls } = spyTool('grep');
        const shared = new ToolCallCache();
        const cached = new CachingTool(tool, shared);

        // Same args, different runs: each must execute (no cross-run reuse).
        await cached.execute({ pattern: 'x' }, { runId: 'runA' } as ToolContext);
        await cached.execute({ pattern: 'x' }, { runId: 'runB' } as ToolContext);
        const hit = await cached.execute(
            { pattern: 'x' },
            { runId: 'runA' } as ToolContext,
        );

        expect(calls()).toBe(2); // one per distinct run
        expect(hit.meta?.cached).toBe(true); // runA repeat is served from cache
    });

    it('clear() drops entries so the next call re-runs', async () => {
        const { tool, calls } = spyTool('readFile');
        const store = new ToolCallCache();
        const cached = new CachingTool(tool, store);

        await cached.execute({ path: 'a.ts' }, ctx);
        store.clear();
        await cached.execute({ path: 'a.ts' }, ctx);

        expect(calls()).toBe(2);
        expect(store.stats).toEqual({ hits: 0, misses: 1, size: 1 });
    });
});

describe('withRunCache', () => {
    it('shares one cache across wrapped tools and reports hit/miss stats', async () => {
        const a = spyTool('grep');
        const b = spyTool('readFile');
        const { tools, cache } = withRunCache([a.tool, b.tool]);
        const [grep, readFile] = tools;

        await grep.execute({ pattern: 'x' }, ctx); // miss
        await grep.execute({ pattern: 'x' }, ctx); // hit
        await readFile.execute({ path: 'y' }, ctx); // miss

        expect(a.calls()).toBe(1);
        expect(b.calls()).toBe(1);
        expect(cache.stats).toEqual({ hits: 1, misses: 2, size: 2 });
    });
});
