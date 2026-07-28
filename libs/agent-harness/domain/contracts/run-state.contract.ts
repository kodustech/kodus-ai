/**
 * agent-harness — RunState & Trace primitives (domain-agnostic).
 *
 * RunState is the FIRST-CLASS, observable record of an agent run. It is the
 * antidote to "reconstruct the funnel by heuristic": every step, tool call,
 * artifact and stage transition is recorded here by construction, so
 * downstream observability never has to guess what happened.
 *
 * Domains map `Artifact` to their own type (Finding / Violation / Answer).
 */

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
    readonly role: AgentRole;
    /** Text for simple turns, OR the AI SDK's structured content parts for
     *  `tool`/`assistant` turns (an array of tool-result / tool-call / text
     *  parts). MUST stay structured end-to-end: stringifying a `tool` turn's
     *  content makes the AI SDK crash on `content.filter` during prompt
     *  conversion, and flattens tool-call/tool-result pairing on `assistant`. */
    readonly content: string | readonly unknown[];
    /** Tool call(s) the assistant requested in this message, if any. */
    readonly toolCalls?: readonly ToolCallRecord[];
}

export interface ToolCallRecord {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
    /** Filled once the tool runs. */
    readonly output?: string;
    readonly isError?: boolean;
    readonly durationMs?: number;
}

export interface RunStep {
    readonly index: number;
    /** What the model produced this step (text + any tool calls). */
    readonly message: AgentMessage;
    /** Token usage for the step, if the provider reported it. */
    readonly usage?: TokenUsage;
}

export interface TokenUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}

/** Raw structured output of an agent run. Generic on purpose — the core
 *  produces Artifacts; each domain maps them to Finding/Violation/etc. */
export interface Artifact {
    readonly type: string;
    readonly payload: unknown;
    /** Where it came from (file:line, doc id...), domain-interpreted. */
    readonly location?: string;
    /** Provenance: which policy/stage last touched it (observability). */
    readonly stage?: string;
}

export type RunStatus = 'completed' | 'stopped' | 'budget-exhausted' | 'error';

/** The complete, observable result of one agent run. */
export interface RunState {
    readonly runId: string;
    readonly agentId: string;
    readonly status: RunStatus;
    readonly steps: readonly RunStep[];
    readonly artifacts: readonly Artifact[];
    /** Why the run stopped (which policy fired) — observability. */
    readonly stopReason?: string;
    readonly usage: TokenUsage;
    /** Free-form, append-only event log policies can write to (e.g.
     *  progress debt, budget-band transitions, verify drops). This is the
     *  funnel made observable by construction. */
    readonly trace: readonly TraceEvent[];
}

export interface TraceEvent {
    readonly at: number;
    readonly source: string; // policy/stage name
    readonly kind: string; // e.g. 'progress.debt', 'verify.drop', 'stop'
    readonly detail?: Readonly<Record<string, unknown>>;
}
