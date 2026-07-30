/**
 * code-review (domain) — adapts the existing finder tools (grep/readFile/
 * listDir/getCallers/checkTypes/searchDocs) to the agent-harness AgentTool port,
 * returning a ToolRegistry the new runner can consume.
 *
 * Reuses buildAgentTools verbatim (no tool logic rewritten). The mapping:
 *  - recovers the raw JSON schema from the AI SDK jsonSchema() wrapper
 *  - wraps execute(args) -> Promise<string> into execute(input,ctx) ->
 *    ToolResult, turning thrown errors into {isError:true} values so the
 *    loop can recover instead of crashing.
 *
 * NOTE: the legacy tools read `remoteCommands` from a closure, not from the
 * ToolContext — so for now the registry is built per-run with the sandbox
 * already bound. A later step can move sandbox access into ToolContext.services.
 */
import type {
    AgentTool,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import {
    CachingTool,
    ToolCallCache,
} from '@libs/agent-harness/infrastructure/tools/caching-tool.decorator';
import { OutlineFirstReadTool } from '@libs/code-review/infrastructure/agents/adapters/outline-first-read.decorator';

import {
    buildAgentTools,
    type DocumentationSearchAdapter,
} from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/** Recover the raw JSON schema from whatever buildAgentTools produced
 *  (AI SDK jsonSchema() wrapper exposes `.jsonSchema`; fall back to as-is). */
function rawSchema(inputSchema: any): JSONSchema {
    if (
        inputSchema &&
        typeof inputSchema === 'object' &&
        inputSchema.jsonSchema
    ) {
        return inputSchema.jsonSchema as JSONSchema;
    }
    return (inputSchema ?? { type: 'object', properties: {} }) as JSONSchema;
}

/** Finder tools whose output is a pure function of repo state within a run, so
 *  identical calls can be memoized (see CachingTool). The domain owns this
 *  policy — it knows which of its tools are side-effect-free reads. checkTypes
 *  and searchDocs are intentionally excluded. */
const READ_ONLY_NAV_TOOLS = new Set([
    'grep',
    'readFile',
    'listDir',
    'getCallers',
    // External repo read via the GitHub API — pure for a given (repo,path,branch)
    // within a run, and the costliest call to repeat (a network round-trip).
    'readReference',
]);

/** Named options for the finder tool registry — same fields buildAgentTools
 *  takes positionally, but callers pass only what they need instead of
 *  threading `undefined` placeholders. */
export interface FinderToolRegistryOptions {
    remoteCommands: RemoteCommands | undefined;
    gitHubToken?: string;
    repositoryFullName?: string;
    documentationSearchService?: DocumentationSearchAdapter;
    documentationSearchOptions?: Record<string, unknown>;
    callGraph?: string;
    /** Gated (default off): wrap readFile so a range-less read of a large file
     *  returns a symbol outline instead of dumping the head. A/B knob. */
    outlineFirst?: boolean;
}

export function buildFinderToolRegistry(
    options: FinderToolRegistryOptions,
): { registry: ToolRegistry; cache: ToolCallCache } {
    const raw = buildAgentTools(
        options.remoteCommands,
        options.gitHubToken,
        options.repositoryFullName,
        options.documentationSearchService,
        options.documentationSearchOptions,
        options.callGraph,
    );

    const tools: AgentTool[] = Object.entries(raw).map(
        ([name, def]: [string, any]) => ({
            name,
            description: def.description,
            inputSchema: rawSchema(def.inputSchema),
            async execute(input) {
                try {
                    const out = await def.execute(input);
                    return {
                        output: typeof out === 'string' ? out : String(out),
                    };
                } catch (err: any) {
                    return {
                        output: err?.message
                            ? String(err.message)
                            : String(err),
                        isError: true,
                    };
                }
            },
        }),
    );

    // Memoize the pure repo-navigation tools for the lifetime of this run: the
    // repo is static during a finder pass, so an identical grep/read/list/
    // callers call has the same answer — agents (esp. Opus) re-read the same
    // ranges "to gain confidence", which only burns tokens. checkTypes/
    // searchDocs are left uncached (rarely repeated; external/heavier). The
    // cache is per-run because the registry is built per-run.
    const cache = new ToolCallCache();
    const cached = tools.map((tool) => {
        // Gated outline-first wraps readFile, composed INSIDE the cache so the
        // outline itself is memoized: Caching(OutlineFirst(readFile)).
        const base =
            options.outlineFirst &&
            tool.name === 'readFile' &&
            options.remoteCommands?.read
                ? new OutlineFirstReadTool(tool, {
                      readFull: (p) =>
                          options.remoteCommands!.read(p, 0, 0),
                  })
                : tool;
        return READ_ONLY_NAV_TOOLS.has(tool.name)
            ? new CachingTool(base, cache)
            : base;
    });

    // Return the cache alongside the registry so the caller (composition root)
    // owns its lifecycle and can surface hit/miss stats for the run.
    return { registry: new InMemoryToolRegistry(cached), cache };
}
