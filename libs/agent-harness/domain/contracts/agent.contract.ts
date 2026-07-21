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
    /** Model identifier (resolved by the infra model provider / BYOK). */
    readonly modelId: string;
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
    /** Opaque provider options forwarded to the model call (e.g. reasoning /
     *  thinking config). The harness does not interpret these — the domain
     *  builds them (provider-specific) and the runner passes them through. */
    readonly providerOptions?: Readonly<Record<string, unknown>>;
    /** Opaque provider options attached to the SYSTEM message specifically
     *  (e.g. Anthropic `cacheControl: ephemeral` so a long system prompt is
     *  cached across the loop's steps). When set, the runner sends the system
     *  prompt as a system message carrying these options instead of a bare
     *  string. Domain-built; the harness does not interpret them. */
    readonly systemProviderOptions?: Readonly<Record<string, unknown>>;
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
    /** Opaque per-run telemetry forwarded to the model call as the AI SDK's
     *  `experimental_telemetry` (the harness does not interpret it). Per-RUN so
     *  each call — finder, each recall pass, each per-finding verify — can carry
     *  its own observation name; the domain builds it (e.g. Langfuse). */
    readonly telemetry?: Readonly<Record<string, unknown>>;
}

/** Adapter that exposes an AgentSpec AS A TOOL (sub-agent-as-tool pattern).
 *  This is how orchestration composes agents: a parent calls a sub-agent
 *  the same way it calls grep. Gives context isolation (own window) and
 *  returns a distilled summary, not the full transcript.
 *
 *  STAGED (no consumer yet): reserved for internal multi-agent orchestration —
 *  finder + verifier + security/test-gen coordinated on one runner (Fase 4).
 *  Kept rather than pruned because it is on the roadmap (not build-ahead
 *  guesswork) and DefaultSubAgentFactory is already tested. Wire the first
 *  consumer when Fase 4 lands, or prune if that work is dropped. */
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
