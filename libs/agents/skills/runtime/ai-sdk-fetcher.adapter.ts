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
import { type BYOKConfig } from '@kodus/kodus-common/llm';
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
import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';
import { resolveAgentModel } from '@libs/llm/agent-model';

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
    byokConfig?: BYOKConfig;
    agentId: string;
    systemPrompt: string;
    prompt: string;
    tools: ToolRegistry;
    maxSteps: number;
    providerOptions?: Record<string, unknown>;
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
    // Standard model setup (same helper as every agent): BYOK resolve +
    // concurrency limiter + failure reporter.
    const model: LanguageModel = resolveAgentModel(params.byokConfig, {
        organizationId: params.telemetry?.organizationId,
        provider: params.byokConfig?.main?.provider ?? params.telemetry?.provider,
        reporter: params.reporter,
    });
    const runner = new AiSdkAgentRunner({ resolve: () => model });

    // Cross-cutting as composable policies on the AgentSpec (the loop is thin;
    // behavior lives here). Compression is the first: a no-op until the window
    // approaches its threshold, so adding it can't regress a small fetch.
    const policies: AgentPolicy[] = params.contextWindowTokens
        ? [
              new CompressionPolicy(
                  new ContextWindowCompressor(params.contextWindowTokens),
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
        ...(params.providerOptions
            ? { providerOptions: params.providerOptions }
            : {}),
    };

    const telemetry = params.telemetry
        ? buildLangfuseTelemetry(params.telemetry.functionId, {
              organizationId: params.telemetry.organizationId,
              teamId: params.telemetry.teamId,
              provider: params.telemetry.provider,
          })
        : undefined;

    const state = await runner.run(
        spec,
        { prompt: params.prompt, ...(telemetry ? { telemetry } : {}) },
        { runId: params.runId, signal: params.signal },
    );

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
