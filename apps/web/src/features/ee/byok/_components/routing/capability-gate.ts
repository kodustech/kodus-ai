import type { LlmTask } from "../../_types";

/**
 * The gate-relevant subset of the registry's ModelCapabilities, surfaced to the
 * client on `LLMModelStatus.capabilities` (get-llm-config-status.use-case.ts).
 * Mirror of libs/llm/providers/types.ts — a STATIC descriptor, never a secret.
 */
export type SurfacedCapabilities = {
    structuredOutput?: string;
    toolCalling?: string;
};

export type CapabilityGateResult = {
    ok: boolean;
    /** Human tooltip reason when !ok. */
    reason?: string;
    /** Set when caps was undefined — a soft-OK, not a proven pass. */
    unknown?: boolean;
};

/**
 * Pure client mirror of TASK_CAPABILITY_REQUIREMENTS
 * (libs/llm/static-task-strategy.ts:53-63). KEEP IN SYNC with the backend:
 *  - codeReview   requires structuredOutput !== 'none'
 *  - conversation requires toolCalling === 'native'
 *  - prSummary    has no requirement (always ok)
 *
 * This is the LIVE pre-save warning (resolved 2026-07-29): the grid disables an
 * incompatible cell BEFORE save. The backend StaticTaskStrategy re-evaluates
 * every route and remains the authoritative backstop, so an undefined caps
 * (unknown/unregistered provider) is a SOFT-OK — we never hard-block on unknown.
 */
export const capabilityGate = (
    task: LlmTask,
    caps: SurfacedCapabilities | undefined,
    modelLabel = "This model",
): CapabilityGateResult => {
    // Unknown capabilities → soft-OK: let the user save; the backend decides.
    if (!caps) return { ok: true, unknown: true };

    if (task === "codeReview" && caps.structuredOutput === "none") {
        return {
            ok: false,
            reason: `${modelLabel} can't do structured output, which code review requires.`,
        };
    }

    if (task === "conversation" && caps.toolCalling !== "native") {
        return {
            ok: false,
            reason: `${modelLabel} can't do native tool calling, which conversation requires.`,
        };
    }

    return { ok: true };
};
