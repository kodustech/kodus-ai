/**
 * agent-harness — AiSdkToolRegistry (infrastructure/ai-sdk layer).
 *
 * A ToolRegistry that holds pre-built Vercel AI SDK tools directly.
 *
 * Why this exists: some agents (conversation, business-rules) source their
 * tools dynamically AS AI SDK tools — MCP servers expose them `jsonSchema()`-
 * wrapped, native repo tools use Zod schemas. Re-expressing those as the
 * harness's JSON-Schema `AgentTool` and letting the runner re-wrap them
 * (`jsonSchema(t.inputSchema)`) would be a lossy schema round-trip (unwrap the
 * MCP wrapper, convert Zod → JSON Schema and back). Lossy round-trips are a
 * code smell; this avoids it.
 *
 * Instead this registry carries the AI SDK tools as-is and hands them to the
 * runner via `toAiSdkToolMap()`, bypassing the `AgentTool -> aiTool()`
 * conversion. `list()`/`get()` still return lightweight AgentTool views
 * (name + description) so policies and the StepView (`activeTools`) keep
 * working unchanged — Liskov-clean: it IS a ToolRegistry.
 *
 * Lives in `infrastructure/ai-sdk/` — the only layer allowed to know the AI SDK
 * exists; the domain contracts stay framework-agnostic.
 */
import type { Tool } from 'ai';

import type { JSONSchema } from '../../domain/contracts/json-schema.contract';
import type {
    AgentTool,
    ToolRegistry,
    ToolResult,
} from '../../domain/contracts/tool.contract';

/** Optional capability: a registry that can yield native AI SDK tools. The
 *  runner detects it and skips the AgentTool conversion. Interface-segregated
 *  from ToolRegistry so only AI-SDK-backed registries opt in. */
export interface AiSdkToolSource {
    toAiSdkToolMap(): Record<string, Tool>;
}

export function isAiSdkToolSource(value: unknown): value is AiSdkToolSource {
    return (
        !!value &&
        typeof (value as AiSdkToolSource).toAiSdkToolMap === 'function'
    );
}

export class AiSdkToolRegistry implements ToolRegistry, AiSdkToolSource {
    private readonly tools: Record<string, Tool>;
    private readonly views: Map<string, AgentTool>;

    constructor(tools: Record<string, Tool>) {
        this.tools = tools;
        this.views = new Map(
            Object.entries(tools).map(([name, t]) => [
                name,
                {
                    name,
                    description:
                        typeof t.description === 'string' ? t.description : '',
                    // Views are for naming/gating only; the real schema lives in
                    // the AI SDK tool the runner executes. Empty by design.
                    inputSchema: {} as JSONSchema,
                    // Never invoked: the runner executes via toAiSdkToolMap().
                    // Present only to satisfy the AgentTool contract.
                    execute: async (): Promise<ToolResult> => ({
                        output: '',
                        isError: true,
                    }),
                } satisfies AgentTool,
            ]),
        );
    }

    get(name: string): AgentTool | undefined {
        return this.views.get(name);
    }

    list(): readonly AgentTool[] {
        return [...this.views.values()];
    }

    toAiSdkToolMap(): Record<string, Tool> {
        return this.tools;
    }
}
