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
import { buildClaudeCodeTools } from '@libs/code-review/infrastructure/agents/engine/claude-code-tools.factory';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import type { LinkedRepoAccess } from '@libs/ee/linked-repositories';

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
    'Read',
    'Grep',
    'Glob',
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
    /** Cross-repo linked-repo access (#1576). When set, tools accept repo=. */
    linkedRepoAccess?: LinkedRepoAccess;
    /** Tools appended after the finder's own (a custom agent's astGrep and
     *  read-only MCP tools). Not memoized — an MCP server is not repo state.
     *  One whose name is already taken is dropped: it never replaces a
     *  finder tool. */
    extraTools?: readonly AgentTool[];
    /** Repository tools' interface (#2113, A10). 'kodus' (default): grep /
     *  readFile / listDir as they are. 'claude-code': the same sandbox behind
     *  Claude Code's Read / Grep / Glob. Decided by the eval matrix (T35). */
    toolShape?: 'kodus' | 'claude-code';
}

/** The repository tools Claude Code's Read / Grep / Glob replace. */
const CLAUDE_CODE_REPLACES = new Set(['grep', 'readFile', 'listDir']);

export function buildFinderToolRegistry(options: FinderToolRegistryOptions): {
    registry: ToolRegistry;
    cache: ToolCallCache;
} {
    const built = buildAgentTools(
        options.remoteCommands,
        options.gitHubToken,
        options.repositoryFullName,
        options.documentationSearchService,
        options.documentationSearchOptions,
        options.callGraph,
        options.linkedRepoAccess,
    );
    const raw =
        options.toolShape === 'claude-code'
            ? {
                  ...buildClaudeCodeTools(options.remoteCommands),
                  ...Object.fromEntries(Object.entries(built).filter(([name]) => !CLAUDE_CODE_REPLACES.has(name))),
              }
            : built;

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
                      readFull: (p) => options.remoteCommands!.read(p, 0, 0),
                  })
                : tool;
        return READ_ONLY_NAV_TOOLS.has(tool.name)
            ? new CachingTool(base, cache)
            : base;
    });

    const taken = new Set(cached.map((tool) => tool.name));
    for (const extra of options.extraTools ?? []) {
        if (taken.has(extra.name)) continue;
        taken.add(extra.name);
        cached.push(extra);
    }

    // Return the cache alongside the registry so the caller (composition root)
    // owns its lifecycle and can surface hit/miss stats for the run.
    return { registry: new InMemoryToolRegistry(cached), cache };
}
