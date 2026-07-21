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
import {
    BoundedResultStore,
    BoundedResultTool,
    makeFetchResultTool,
} from '@libs/agent-harness/infrastructure/tools/bounded-result.decorator';
import { OutlineFirstReadTool } from '@libs/code-review/infrastructure/agents/adapters/outline-first-read.decorator';
import { makeGetKodyRuleTool } from '@libs/code-review/infrastructure/agents/adapters/kody-rule-disclosure';
import type { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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

/** High-fan-out tools whose raw output can flood the finder window (a grep of
 *  hundreds of matches, a listing of a huge dir, a wide caller set). When the
 *  bounding knob is on, these are wrapped so the model gets a preview + handle
 *  and pulls slices via `fetchResult`. readFile is excluded — the outline-first
 *  decorator already governs large reads. */
const BOUNDED_RESULT_TOOLS = new Set(['grep', 'listDir', 'getCallers']);

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
    /** Gated (default off): wrap high-fan-out tools (grep/listDir/getCallers) so
     *  an oversized result is stored out-of-band and the model gets a preview +
     *  handle instead of the flood, pulling slices via `fetchResult`. A/B knob. */
    boundedResults?: boolean;
    /** Gated (default off): expose a `getKodyRule` tool so the finder can pull a
     *  long memory rule's full body on demand (the system prompt carries only a
     *  compact index). No-op without `memoryRules`. A/B knob. */
    progressiveRules?: boolean;
    /** Team memory rules the getKodyRule tool serves from. */
    memoryRules?: Partial<IKodyRule>[];
}

export function buildFinderToolRegistry(
    options: FinderToolRegistryOptions,
): { registry: ToolRegistry; cache: ToolCallCache; boundedStore: BoundedResultStore } {
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
    const boundedStore = new BoundedResultStore();
    const cached = tools.map((tool) => {
        // Gated outline-first wraps readFile, composed INSIDE the cache so the
        // outline itself is memoized: Caching(OutlineFirst(readFile)).
        let base =
            options.outlineFirst &&
            tool.name === 'readFile' &&
            options.remoteCommands?.read
                ? new OutlineFirstReadTool(tool, {
                      readFull: (p) =>
                          options.remoteCommands!.read(p, 0, 0),
                  })
                : tool;
        // Gated bounding for high-fan-out tools, composed INSIDE the cache so the
        // bounded shape (preview + handle) is what gets memoized:
        // Caching(Bounded(grep)). A cache hit re-serves the same handle, still
        // valid in the store (Bounded did not re-run).
        if (options.boundedResults && BOUNDED_RESULT_TOOLS.has(tool.name)) {
            base = new BoundedResultTool(base, boundedStore);
        }
        return READ_ONLY_NAV_TOOLS.has(tool.name)
            ? new CachingTool(base, cache)
            : base;
    });

    // When bounding is on, the model needs the companion tool to pull slices of
    // a bounded result by its handle. Not cached (a cheap in-memory lookup).
    if (options.boundedResults) {
        cached.push(makeFetchResultTool(boundedStore));
    }

    // Progressive rule disclosure: the system prompt carries only a compact
    // index of the memory rules, so give the model the companion tool to pull a
    // long rule's full body on demand. No-op without rules. Not cached (a cheap
    // in-memory lookup over the rule set).
    if (options.progressiveRules && options.memoryRules?.length) {
        cached.push(makeGetKodyRuleTool(options.memoryRules));
    }

    // Return the cache + bounded store alongside the registry so the caller
    // (composition root) owns their lifecycle and can surface run stats.
    return { registry: new InMemoryToolRegistry(cached), cache, boundedStore };
}
