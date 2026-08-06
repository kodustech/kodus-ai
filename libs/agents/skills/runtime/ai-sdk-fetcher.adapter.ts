/**
 * Skills engine — bridge from the legacy flow-engine orchestration to the
 * **agent-harness** (`AiSdkAgentRunner`). This is the first non-code-review
 * consumer of the harness: the generic skill "fetcher" (a REACT agent that
 * gathers task context via MCP tools) now runs on the same one-and-only agent
 * loop the code-review finder/verifier use.
 *
 * MCP runs on the local MCP adapter (`createMCPAdapter`) — this only wraps the
 * adapter's tools as harness `AgentTool`s and runs the loop on the AI SDK.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import { type MCPAdapter } from '@libs/mcp-server/mcp-adapter';
import { type LanguageModel } from 'ai';

import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import type {
    AgentPolicy,
    AgentSpec,
    AgentTool,
    JSONSchema,
    RunState,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { resolveModelInvocation } from '@libs/llm/model-invocation';
import { systemCacheControl } from '@libs/llm/system-cache';
import { isContextOverflowResult } from '@libs/llm/context-overflow';

/**
 * Wrap a connected flow `MCPAdapter`'s tools as a harness `ToolRegistry`.
 * Tool names are kept verbatim; execution routes back through
 * `adapter.executeTool(name, args)`. Tool failures are surfaced to the model
 * as `{ isError: true }` (the harness convention) instead of throwing.
 */
export async function buildMcpAgentToolRegistry(
    adapter: MCPAdapter,
): Promise<ToolRegistry> {
    const tools = new Map<string, AgentTool>();
    const mcpTools = await adapter.getTools();

    for (const mcpTool of mcpTools) {
        const name = mcpTool.name;
        tools.set(name, {
            name,
            description: mcpTool.description ?? '',
            inputSchema: (mcpTool.inputSchema ?? {
                type: 'object',
                properties: {},
            }) as JSONSchema,
            execute: async (input) => {
                try {
                    const result = await adapter.executeTool(
                        name,
                        (input ?? {}) as Record<string, unknown>,
                    );
                    return {
                        output:
                            typeof result === 'string'
                                ? result
                                : JSON.stringify(result ?? null),
                    };
                } catch (error) {
                    return {
                        output:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        isError: true,
                    };
                }
            },
        });
    }

    return {
        get: (toolName: string) => tools.get(toolName),
        list: () => [...tools.values()],
    };
}

export interface FetcherRunResult {
    /** Final assistant text — the fetcher's structured JSON answer. */
    text: string;
    /** Full run state (steps, usage, trace) for billing/observability. */
    state: RunState;
    /**
     * Token usage in the AI-SDK shape (with `totalTokens` computed) so the
     * caller can feed `ObservabilityService.runAiSdkLLMInSpan` for Mongo billing.
     */
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
    };
}

/**
 * Run a skill fetcher agent on the harness. Builds a fixed-model
 * `AgentSpec` + `AiSdkAgentRunner` (BYOK model resolved once, returned for any
 * `modelId`) and returns the final text plus the `RunState`.
 *
 * The result is the LAST assistant step's text — matching the legacy fetcher
 * contract of returning a JSON string the capabilities parse. Langfuse parity
 * is via `input.telemetry` (forwarded as AI SDK `telemetry`); Mongo
 * billing is emitted by the caller from `state.usage`.
 */
export async function runMcpFetcherAgent(params: {
    byokConfig?: NormalizedModel;
    agentId: string;
    systemPrompt: string;
    prompt: string;
    tools: ToolRegistry;
    maxSteps: number;
    runId: string;
    signal?: AbortSignal;
    /** Model context window (tokens). When set, a CompressionPolicy compacts the
     *  message window before it overflows — same primitive the code-review finder
     *  uses. OFF when absent: don't guess a window (wrong value over-compresses or
     *  under-protects); a skill opts in via SKILL.md with its model's real size. */
    contextWindowTokens?: number;
    /** BYOK failure reporter (ByokErrorCounter.record) — same as every agent. */
    reporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
    telemetry?: {
        functionId: string;
        organizationId?: string;
        teamId?: string;
        provider?: string;
    };
}): Promise<FetcherRunResult> {
    // ONE resolution for model + tuning + reasoning via the shared primitive
    // every agent uses. The fetcher now honors the slot's temperature /
    // maxOutputTokens (previously dropped) and its reasoning — including
    // reasoningConfigOverride — instead of receiving a half-built providerOptions
    // from the caller. Same derivation as conversation / business-rules / review.
    const invocation = resolveModelInvocation(params.byokConfig, {
        runName: params.telemetry?.functionId ?? params.agentId,
        organizationId: params.telemetry?.organizationId,
        // provider is derived from the slot inside the primitive — same as the
        // conversation / business-rules call-sites (no per-site provider arg).
        reporter: params.reporter,
    });
    const model: LanguageModel = invocation.model;
    const runner = new AiSdkAgentRunner({ resolve: () => model });
    // Anthropic prompt caching for the static system prompt — the fetcher is a
    // multi-step tool loop, so on Claude the prompt is read from cache across
    // steps instead of re-billed each one. No-op on non-Anthropic models.
    const systemCache = systemCacheControl({
        provider: params.byokConfig?.provider,
        model: params.byokConfig?.model,
    });

    const telemetryArgs = params.telemetry
        ? toAiSdkTelemetryArgs(
              buildLangfuseTelemetry(params.telemetry.functionId, {
                  organizationId: params.telemetry.organizationId,
                  teamId: params.telemetry.teamId,
                  provider: params.telemetry.provider,
              }),
          )
        : undefined;

    // Build + run the loop for a given compression window. Extracted so the
    // reactive overflow net can re-run with a tighter window. Compression is a
    // composable policy (the loop stays thin); it's a no-op until the window
    // approaches its threshold, so adding it can't regress a small fetch.
    const runOnce = (windowTokens?: number) => {
        const policies: AgentPolicy[] = windowTokens
            ? [
                  new CompressionPolicy(
                      new ContextWindowCompressor(windowTokens),
                  ),
              ]
            : [];
        const spec: AgentSpec = {
            id: params.agentId,
            systemPrompt: params.systemPrompt,
            modelId: 'resolved',
            tools: params.tools,
            policies,
            maxSteps: params.maxSteps,
            // Slot tuning — omitted keys fall to the provider default.
            ...invocation.callOptions,
            ...(Object.keys(invocation.providerOptions).length
                ? { providerOptions: invocation.providerOptions }
                : {}),
            ...(systemCache ? { systemProviderOptions: systemCache } : {}),
        };
        return runner.run(
            spec,
            { prompt: params.prompt, ...(telemetryArgs ?? {}) },
            { runId: params.runId, signal: params.signal },
        );
    };

    let state = await runOnce(params.contextWindowTokens);

    // Reactive overflow net: a mis-sized window (#1574) can let the loop overflow
    // mid-run despite the proactive compressor. When the failure IS an overflow
    // AND we had a window to tighten, re-run ONCE at 60% (the compressor trims
    // harder) instead of failing the whole fetch. Any other failure is left as-is
    // — re-running wouldn't help.
    if (params.contextWindowTokens && isContextOverflowResult(state)) {
        state = await runOnce(Math.floor(params.contextWindowTokens * 0.6));
    }

    // `state.usage` is harness TokenUsage (AiSdkAgentRunner already maps
    // ai@7 `outputTokenDetails.reasoningTokens` / `inputTokenDetails.cacheReadTokens`
    // via readAiSdkUsage) — not raw LanguageModelUsage.
    const inputTokens = state.usage?.inputTokens;
    const outputTokens = state.usage?.outputTokens;

    return {
        text: extractFinalText(state),
        state,
        usage: {
            inputTokens,
            outputTokens,
            totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
            reasoningTokens: state.usage?.reasoningTokens,
        },
    };
}

/** The fetcher's answer is the last assistant step carrying non-empty text. */
function extractFinalText(state: RunState): string {
    for (let i = state.steps.length - 1; i >= 0; i--) {
        const content = state.steps[i]?.message?.content;
        if (typeof content === 'string' && content.trim()) {
            return content;
        }
    }
    return '';
}
