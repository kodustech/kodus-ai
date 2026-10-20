/**
 * code-review (domain) — results of read-only tool calls, kept for one review
 * run of one agent.
 *
 * The finder, its recall passes and the verifiers each start from a fresh
 * history, so they ask the same MCP tool or skill file again with the same
 * arguments. This cache serves the repeat without running the call again.
 *
 * Scope is the owner's job and the key's: the custom agent provider holds one
 * per review and agent (a new provider is built per review), and every key
 * carries the connection or skill it reads. Concurrent identical calls share
 * one execution. A failure is never kept, so the next identical call runs.
 */
import type { ToolResult } from '@libs/agent-harness/domain/contracts/tool.contract';

/** Canonical, order-insensitive serialization so {a,b} keys equal {b,a}. */
export function stableKey(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableKey).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableKey(record[k])}`)
        .join(',')}}`;
}

export class RunToolCache {
    private readonly store = new Map<string, Promise<ToolResult>>();

    /**
     * The result kept under `parts`, or `run()`'s. A result with `isError`
     * or a thrown error is dropped, so it is never served again.
     */
    async getOrRun(
        parts: readonly string[],
        run: () => Promise<ToolResult>,
    ): Promise<ToolResult> {
        // NUL separators: no part can run into the next.
        const key = parts.join('\u0000');
        const kept = this.store.get(key);
        if (kept) return kept;

        const pending = run().then(
            (result) => {
                if (result.isError) this.store.delete(key);
                return result;
            },
            (error) => {
                this.store.delete(key);
                throw error;
            },
        );
        this.store.set(key, pending);
        return pending;
    }

    get size(): number {
        return this.store.size;
    }
}
