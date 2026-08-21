/**
 * LLM task taxonomy + the routing-inheritance map — a ZERO-dependency leaf.
 *
 * This file intentionally imports nothing. It is the one place the backend
 * resolver AND the web routing UI both read the task set (`LLM_TASK` / `LlmTask`)
 * and the inheritance graph (`TASK_ROUTING_FALLBACK`) from, so the two never
 * drift by hand-copying. `byok-config.ts` re-exports these for the backend; the
 * web imports them straight from here. Keeping it import-free is what lets the
 * isolated `apps/web` production build bundle it without dragging the rest of
 * `libs/llm` (AI SDK, providers, kernel) into the web image — see
 * `docker/Dockerfile.web`, which copies just this leaf.
 */

/**
 * LLM task taxonomy for routing — the named source of truth for every
 * `resolveTaskSlot`/`resolveTaskModel` call. `as const` keeps the values plain
 * strings (so `routing.taskOverrides` keys, stored configs, and JSON still
 * match), while `LlmTask` is derived from it so the union can never drift from
 * the constant. Reference tasks as `LLM_TASK.codeReview`, not the bare literal.
 */
export const LLM_TASK = {
    codeReview: 'codeReview',
    /** The Kody-Rules review agent (categoryLabel 'kody_rules') — enforcing the
     *  org's authored rules on a PR. A distinct workload from the defect-finding
     *  agents (bug/perf/security/generalist) that stay under `codeReview`, so it
     *  can run on a different (often cheaper) model. Inherits `codeReview` when
     *  unset (see TASK_ROUTING_FALLBACK). */
    kodyRulesReview: 'kodyRulesReview',
    /** Generating/learning Kody Rules (from PR history, feedback, initial scan).
     *  Generative work, unlike per-PR detection. Inherits `codeReview` when unset. */
    ruleGeneration: 'ruleGeneration',
    /** The business-rules validation agent. Inherits `codeReview` when unset. */
    businessValidation: 'businessValidation',
    prSummary: 'prSummary',
    conversation: 'conversation',
} as const;

export type LlmTask = (typeof LLM_TASK)[keyof typeof LLM_TASK];

/**
 * Task → the task it inherits a routing target from when it has no explicit
 * `taskOverrides[task]`. The resolver applies it between the task's own override
 * and the org default (see StaticTaskStrategy); the routing UI mirrors it to
 * nest inheriting rows under their parent. Lives HERE (a bundle-safe leaf, like
 * LLM_TASK) so the backend resolver and the frontend grid import the SAME map
 * instead of hand-copying it — the inheritance graph has one source of truth.
 *
 * Each addition inherits the task it was carved out of, so an org that never
 * sets the new override keeps exactly today's behavior:
 *  - kodyRulesReview / ruleGeneration were part of the code-review flow → codeReview
 *  - businessValidation ran on the agent (chat) model → conversation
 * A single hop only (no chains).
 */
export const TASK_ROUTING_FALLBACK: Partial<Record<LlmTask, LlmTask>> = {
    kodyRulesReview: LLM_TASK.codeReview,
    ruleGeneration: LLM_TASK.codeReview,
    businessValidation: LLM_TASK.conversation,
};
