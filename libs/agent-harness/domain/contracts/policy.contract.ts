/**
 * agent-harness — Policy primitive (the composable seam).
 *
 * A Policy is a named, independently-testable interceptor over the agent
 * loop. It replaces the 22 cross-cutting hooks inlined in the legacy
 * 4600-line loop (step budget, progress ledger, context compression,
 * verify-in-loop, done-handling, timeout recovery).
 *
 * Maps to the documented SOTA seams:
 *  - shouldStop  -> Vercel `stopWhen` (OR semantics across policies)
 *  - prepareStep -> Vercel `prepareStep` (swap model, gate tools, edit msgs)
 *  - lifecycle   -> LangChain before/after hooks (logging, state, trace)
 *
 * Each policy is pure w.r.t. the loop core: it reads a read-only view and
 * returns directives. This is what makes the harness UNIT-TESTABLE without
 * an LLM — feed a fake StepView, assert the directive.
 */

import type { AgentMessage, RunStep, TraceEvent } from './run-state.contract';

/** Read-only snapshot the loop hands to a policy at decision time. */
export interface StepView {
    readonly runId: string;
    readonly agentId: string;
    readonly stepNumber: number;
    readonly maxSteps: number;
    readonly steps: readonly RunStep[];
    /** Current message window (post any prior policy edits). */
    readonly messages: readonly AgentMessage[];
    /** Names of tools currently active. */
    readonly activeTools: readonly string[];
}

/** What a policy may change before the next model step. All optional.
 *
 * MERGE PRECEDENCE (the loop applies directives from all policies in the
 * order they appear in AgentSpec.policies — order IS the priority):
 *  - `modelId` / `activeTools` / `messages` (scalars/replacements): the LAST
 *    policy that sets it wins. A later override of a value an earlier policy
 *    already set is reported as a `policy.conflict` trace event — observable,
 *    never silent (this is the bug class that bit us with injectNote.role).
 *  - `injectNote`: notes from ALL policies are CONCATENATED (policy order)
 *    into a single trailing turn; the loop forces role:'user'.
 *  - `emit`: events from all policies are appended to the trace. */
export interface StepDirectives {
    /** Replace the message window (e.g. compression). */
    readonly messages?: readonly AgentMessage[];
    /** Restrict tools available this step (the `activeTools` gate). */
    readonly activeTools?: readonly string[];
    /** Swap the model for this step (e.g. cheaper model near budget end). */
    readonly modelId?: string;
    /** Trailing USER note to inject (e.g. progress debt, budget band). Kept
     *  separate from `messages` so caching prefixes aren't invalidated. Role is
     *  always 'user': providers (Google Gemini) reject a system message that is
     *  not the first message, and the real system prompt is carried by the
     *  runner via generateText({ system }). A mid-conversation system note is
     *  impossible by construction — so the type does not offer it. */
    readonly injectNote?: { role: 'user'; content: string };
    /** Events to append to the run trace (observability). The loop stamps
     *  `at` and `source` (the policy name) — the policy supplies the rest. */
    readonly emit?: readonly Omit<TraceEvent, 'at' | 'source'>[];
}

export interface AgentPolicy {
    readonly name: string;

    /** Called once before the loop starts. */
    onRunStart?(view: StepView): void | Promise<void>;

    /** prepareStep seam — runs before each model step. */
    prepareStep?(view: StepView): StepDirectives | Promise<StepDirectives>;

    /** stopWhen seam — return true to stop the loop. The loop stops if ANY
     *  policy returns true (OR semantics). The runner ALWAYS enforces a
     *  hard maxSteps fail-open regardless of policies. */
    shouldStop?(view: StepView): boolean | Promise<boolean>;

    /** Called after each completed step (marking progress, accumulating
     *  trace). Read-only w.r.t. control flow. */
    onStepFinish?(view: StepView): void | Promise<void>;

    /** Called once after the loop ends. */
    onRunFinish?(view: StepView): void | Promise<void>;
}
