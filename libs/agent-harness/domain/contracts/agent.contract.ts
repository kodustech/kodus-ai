/**
 * agent-harness — AgentSpec, AgentRunner, SubAgent.
 *
 * Key principle (Anthropic practice): role specialization does NOT require
 * a forked loop. finder and verifier are the SAME runner with different
 * AgentSpec (prompt + tool surface + policies). An "agent" is DATA, not a
 * class hierarchy.
 */

import type { AgentPolicy } from './policy.contract';
import type { RunState } from './run-state.contract';
import type { AgentTool, ToolContext, ToolRegistry } from './tool.contract';

/** Declarative configuration of an agent role. Pure data — swap prompt or
 *  tools to get a different role on the same runtime. */
export interface AgentSpec {
    readonly id: string;
    readonly systemPrompt: string;
    /** Cost-attribution label — the observability span's `agentName`. */
    readonly agentName?: string;
    /** Names the Langfuse observation + cost row (defaults to agentName / id). */
    readonly runName?: string;
    /** Phase label on the cost row (e.g. 'conversation' vs 'conversation-retry'). */
    readonly phase?: string;
    /** Observability span name (defaults to runName). */
    readonly spanName?: string;
    /** Tools this role may use. */
    readonly tools: ToolRegistry;
    /** Composable policies (budget, progress, compression, verify...). */
    readonly policies: readonly AgentPolicy[];
    /** Hard ceiling — the runner's fail-open even if no policy stops. */
    readonly maxSteps: number;
    /** Sampling temperature for the model call. Omitted -> provider default.
     *  Generic model-call config (not provider-specific), so it lives on the
     *  spec rather than in `providerOptions`. */
    readonly temperature?: number;
    /** Hard cap on output tokens PER model call. Omitted -> provider default. */
    readonly maxOutputTokens?: number;
    /** Opaque providerOptions (reasoning / thinking) that OVERRIDE the slot-
     *  derived ones. Unset → LLM.run derives them from the slot. The review
     *  finder sets this (config-derived reasoning that can differ from the slot);
     *  the chat/business agents leave it unset. The runner forwards it verbatim. */
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    /** Name of the "final tool" whose call IS the run's structured output.
     *  When set, the runner materializes each call to it into
     *  `RunState.artifacts` (the "result tool" convention) — so the domain
     *  reads `state.artifacts` instead of re-scanning `steps` by hand. This is
     *  the CAPTURE concern; stopping ON that tool is a separate concern owned
     *  by a policy (e.g. CompletionGatePolicy.doneToolName) — same tool,
     *  distinct roles. */
    readonly resultToolName?: string;
}

/** The single agent loop. The ENTIRE harness has exactly one of these.
 *  finder, verifier, replicas, sub-agents — all go through here. */
export interface AgentRunner {
    run(
        spec: AgentSpec,
        input: AgentRunInput,
        ctx: ToolContext,
    ): Promise<RunState>;
}

export interface AgentRunInput {
    /** Opening user message(s) that frame the task. */
    readonly prompt: string;
    /** Optional seed messages (prior context). */
    readonly seedMessages?: readonly { role: 'user' | 'assistant'; content: string }[];
    /** Langfuse observation metadata (org / team / repo / provider ...). Passed
     *  to LLM.run, which builds the vendor telemetry shape — so the caller hands
     *  over the RAW metadata, not a pre-built SDK payload. Opaque here to keep the
     *  domain contract free of the vendor type. */
    readonly telemetryMetadata?: Readonly<Record<string, unknown>>;
    /** Opaque per-run telemetry, forwarded VERBATIM as the model call's
     *  `telemetry`. The harness does not interpret it: the domain hands it over
     *  already in the shape the SDK takes (e.g. `toAiSdkTelemetryArgs`), so the
     *  vendor mapping lives in ONE place, outside the harness. Per-RUN so each
     *  call — finder, each recall pass, each per-finding verify — can carry its
     *  own observation name.
     *
     *  Type the payload with a `type` alias, never an `interface`: interfaces
     *  get no implicit index signature and so do not satisfy `Record<string,
     *  unknown>`, however identical their members look. */
    readonly telemetry?: Readonly<Record<string, unknown>>;
    /** Opaque per-run runtime context, forwarded VERBATIM as the model call's
     *  `runtimeContext`. Carries the values whose keys the telemetry payload
     *  opts into — the tracer records nothing that was not opted in, and both
     *  halves are the domain's call. */
    readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

/** Adapter that exposes an AgentSpec AS A TOOL (sub-agent-as-tool pattern).
 *  This is how orchestration composes agents: a parent calls a sub-agent
 *  the same way it calls grep. Gives context isolation (own window) and
 *  returns a distilled summary, not the full transcript. */
export interface SubAgentFactory {
    asTool(params: {
        name: string;
        description: string;
        spec: AgentSpec;
        /** Input contract the parent calls with. Defaults to {task:string}. */
        inputSchema?: AgentTool['inputSchema'];
        /** Maps the parent's tool input -> the sub-agent's prompt. */
        toPrompt: (input: unknown) => string;
        /** Distills the sub-agent RunState -> the string returned to parent. */
        summarize: (state: RunState) => string;
    }): AgentTool;
}
