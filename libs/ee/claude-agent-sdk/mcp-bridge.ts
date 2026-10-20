/**
 * The loop's tools, as an in-process MCP server the SDK session calls. They run
 * in this process — over the same sandbox (`remoteCommands` / E2B) and with the
 * same context as on the AI SDK path; the subprocess only sees their names,
 * descriptions and schemas.
 */
import { asSchema } from 'ai';

import type { SdkRuntime } from './sdk-runtime';

export const MCP_SERVER_NAME = 'kodus';
export const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** An AI SDK tool as the runner builds it (`tool({...})`). */
export interface LoopTool {
    description?: string;
    inputSchema?: unknown;
    execute?: (input: unknown, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }) => unknown;
}

export const mcpName = (tool: string) => `${MCP_PREFIX}${tool}`;
export const bareName = (name: string) => (name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name);

function jsonSchemaOf(tool: LoopTool): Record<string, unknown> {
    try {
        const schema = tool.inputSchema ? (asSchema(tool.inputSchema as any).jsonSchema as Record<string, unknown>) : undefined;
        return schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
    } catch {
        return { type: 'object', properties: {} };
    }
}

/**
 * The tool's zod shape for the SDK. A schema zod cannot convert gets a
 * permissive shape (each declared field accepts anything) and the tool's own
 * `execute` validates, as on the AI SDK path.
 */
export function shapeOf(z: SdkRuntime['z'], schema: Record<string, unknown>): Record<string, unknown> {
    try {
        const t = z.fromJSONSchema(schema);
        if (t?.shape) return t.shape;
    } catch {
        /* fall through to the permissive shape */
    }
    const props = (schema.properties ?? {}) as Record<string, { description?: string }>;
    return Object.fromEntries(Object.keys(props).map((k) => [k, z.any().describe(props[k]?.description || k)]));
}

function text(output: unknown): string {
    if (typeof output === 'string') return output;
    if (output === undefined || output === null) return '';
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
}

export function toMcpServer(
    runtime: SdkRuntime,
    tools: Record<string, LoopTool>,
    opts: { abortSignal?: AbortSignal } = {},
): { server: unknown; names: string[]; defs: Array<{ name: string; inputSchema: Record<string, unknown>; handler: (args: unknown, extra?: unknown) => Promise<any> }> } {
    const defs = Object.entries(tools)
        .filter(([, t]) => typeof t?.execute === 'function')
        .map(([name, t]) =>
            runtime.tool(
                name,
                t.description || name,
                shapeOf(runtime.z, jsonSchemaOf(t)),
                async (args: unknown) => {
                    try {
                        const output = await t.execute!(args, { toolCallId: '', messages: [], abortSignal: opts.abortSignal });
                        return { content: [{ type: 'text', text: text(output) }] };
                    } catch (err) {
                        return { content: [{ type: 'text', text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
                    }
                },
                { alwaysLoad: true },
            ),
        );
    const names = Object.entries(tools)
        .filter(([, t]) => typeof t?.execute === 'function')
        .map(([name]) => mcpName(name));
    return { server: runtime.createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1', tools: defs }), names, defs: defs as any };
}
