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
 * (libs/llm/static-task-strategy.ts). KEEP IN SYNC with the backend:
 *  - codeReview / kodyRulesReview / ruleGeneration
 *                 require structured output — natively (structuredOutput !==
 *                 'none') OR via native tool calling (generateObject emits the
 *                 object through a tool call for tool-native providers)
 *  - conversation / businessValidation
 *                 require toolCalling === 'native' (tool-using agent loop)
 *  - prSummary    has no requirement (always ok)
 *
 * This is the LIVE pre-save warning (resolved 2026-07-29): the grid disables an
 * incompatible cell BEFORE save. The backend StaticTaskStrategy re-evaluates
 * every route and remains the authoritative backstop, so an undefined caps
 * (unknown/unregistered provider) is a SOFT-OK — we never hard-block on unknown.
 */
/** What each task demands of a model — a task-keyed record (mirror of the
 *  backend TASK_CAPABILITY_REQUIREMENTS shape) rather than ad-hoc `task === …`
 *  lists. Because LlmTask is exhaustive here, a NEW task is a compile error until
 *  it declares its requirement — it can't silently fall through the gate. */
type Requirement = "structuredOutput" | "toolCalling" | null;
const TASK_REQUIREMENT: Record<LlmTask, Requirement> = {
    codeReview: "structuredOutput",
    kodyRulesReview: "structuredOutput",
    ruleGeneration: "structuredOutput",
    businessValidation: "toolCalling",
    conversation: "toolCalling",
    prSummary: null,
};

export const capabilityGate = (
    task: LlmTask,
    caps: SurfacedCapabilities | undefined,
    modelLabel = "This model",
): CapabilityGateResult => {
    // Unknown capabilities → soft-OK: let the user save; the backend decides.
    if (!caps) return { ok: true, unknown: true };

    const requirement = TASK_REQUIREMENT[task];

    // Structured output — natively OR via native tool calling (generateObject
    // emits the object through a tool call for tool-native providers).
    if (
        requirement === "structuredOutput" &&
        caps.structuredOutput === "none" &&
        caps.toolCalling !== "native"
    ) {
        return {
            ok: false,
            reason: `${modelLabel} can't do structured output (natively or via tools), which this task requires.`,
        };
    }

    if (requirement === "toolCalling" && caps.toolCalling !== "native") {
        return {
            ok: false,
            reason: `${modelLabel} can't do native tool calling, which this task requires.`,
        };
    }

    return { ok: true };
};
