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
 * `taskOverrides[task]`. Consumed by BOTH the backend resolver (StaticTaskStrategy)
 * and the frontend routing grid from this one bundle-safe leaf, so the
 * inheritance graph never drifts between them.
 *
 * INTENTIONALLY EMPTY — the routing model is FLAT: a task with no override of its
 * own inherits the org DEFAULT directly (routing.defaultModelId), never another
 * task's model. There is no task→task chaining ("Same as Code Review / Same as
 * Chat"); the UI shows every un-overridden agent as "Use default · <default>".
 *
 * Kept as an (empty) exported map, rather than deleted, so the resolver + UI keep
 * ONE seam to reintroduce a chain here if a future task ever needs one — add an
 * entry and both sides pick it up. No entry ⇒ inherit the default.
 */
export const TASK_ROUTING_FALLBACK: Partial<Record<LlmTask, LlmTask>> = {};
