/**
 * agent-harness — Tool primitive (domain-agnostic).
 *
 * A Tool is a single, self-contained capability the agent can invoke.
 * The core knows nothing about code review: a tool is just a named
 * function with a schema. Domains (code-review, business-rules, docs-qa)
 * supply their own tools or reuse shared tool packs (e.g. repo tools).
 *
 * Design notes (from SOTA research):
 * - Tools must be self-contained, robust to error, unambiguous in use.
 *   Bloated/overlapping tool sets degrade model tool-selection — keep each
 *   tool single-purpose.
 * - Errors are returned as values (ToolResult.isError), never thrown, so
 *   the loop can feed them back to the model instead of crashing.
 */

import type { JSONSchema } from './json-schema.contract';

/** Opaque, per-run execution context handed to every tool. The core stays
 *  domain-agnostic: domains put their own services/handles here via a typed
 *  context they control (e.g. sandbox remoteCommands, repo handle). */
export interface ToolContext {
    /** Correlation id for the current run (tracing). */
    readonly runId: string;
    /** Abort signal — tools MUST respect it for timeouts/cancellation. */
    readonly signal?: AbortSignal;
    /** Domain-supplied services, opaque to the core. */
    readonly services?: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
    /** Text/structured payload fed back to the model. */
    readonly output: string;
    /** True when the call failed but should be surfaced to the model
     *  (not thrown). Lets the agent recover instead of the run dying. */
    readonly isError?: boolean;
    /** Optional structured metadata for observability (not shown to model). */
    readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AgentTool<TInput = unknown> {
    /** Unique, stable name the model calls. */
    readonly name: string;
    /** One-line, action-oriented description for the model. */
    readonly description: string;
    /** Input contract (JSON Schema). The runner validates against it. */
    readonly inputSchema: JSONSchema;
    /** Opt in to provider-native strict/structured tool calling for this tool
     *  (grammar-constrained sampling), when the underlying provider + model
     *  support it. Providers that don't support it ignore the flag. The domain
     *  sets this (e.g. only on a done-tool, and only for strict-capable models);
     *  the runner just forwards it. Leave undefined for best-effort tools. */
    readonly strict?: boolean;
    /** Pure-ish capability: given validated input + context, return a result.
     *  Should not throw for expected failures — return {isError:true}. */
    execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/** A named set of tools available to an agent: hold them and look up by name.
 *  (Tool gating per step is the `activeTools` directive, not a registry view.) */
export interface ToolRegistry {
    get(name: string): AgentTool | undefined;
    list(): readonly AgentTool[];
}
