/**
 * The single assembly for a harness agent's cost record — the shape that used to
 * be hand-copied at every `recordAgentRunUsage` call-site (and drifted: the
 * conversation retry once recorded `model: 'resolved'`, the spec sentinel,
 * instead of the real model).
 *
 * Two drift-prone fields are derived here ONCE, never at the call-site:
 *   - `model`  = the resolved BYOK slot's model (NEVER `spec.modelId`, which is
 *                the literal 'resolved' sentinel the runner resolves by).
 *   - `isByok` = slot presence (a resolved slot = the org's own key → 'byok').
 *
 * `recordAgentRunUsage` owns the span/attribute schema; this owns the per-run
 * value assembly. Kept in @libs/agents (not the harness) so the engine stays
 * observability-agnostic — RunState/TokenUsage are imported type-only.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type {
    RunState,
    TokenUsage,
} from '@libs/agent-harness/domain/contracts/run-state.contract';

/** The drift-prone pair, derived from the resolved slot in ONE place. Spread it
 *  wherever a cost record needs `{ model, isByok }` so no call-site re-derives
 *  (and mis-derives) them. */
export function agentModelIdentity(slot: NormalizedModel | null | undefined): {
    model: string | undefined;
    isByok: boolean;
    byokModelId: string | undefined;
    credentialId: string | undefined;
} {
    return {
        model: slot?.model,
        isByok: !!slot,
        // Stable attribution ids from the resolved slot (undefined on the
        // env/managed-default path). Stamped on the usage span so spend
        // attributes by id, not the versioned response model-name.
        byokModelId: slot?.byokModelId,
        credentialId: slot?.credentialId,
    };
}

/** Call-site labels + pass-through attributes for a cost record — everything the
 *  assembler does NOT derive from the slot/state. */
export interface AgentUsageMeta {
    agentName: string;
    phase: string;
    spanName?: string;
    runName?: string;
    /** The org/team the run belongs to — the domain type; the assembler flattens
     *  it to the `organizationId`/`teamId` columns the cost record carries. */
    organizationAndTeamData?: OrganizationAndTeamData;
    prNumber?: number;
    source?: string;
    durationMs?: number;
    /** Routing task/route this run served + whether the fallback model was used
     *  — #1388 LLM-metadata the slot alone doesn't carry (known at the call-site
     *  from the routing verdict). Optional: omitted where unknown. */
    route?: string;
    usedFallback?: boolean;
    extraAttributes?: Record<string, unknown>;
}

/**
 * Build the full `recordAgentRunUsage` payload for a RunState-based agent run:
 * `model` + `isByok` from the slot, and `usage` / `steps` / `finishReason`
 * straight from the RunState. The conversation main + retry passes are the same
 * shape through this — the duplication where the model-sentinel bug lived.
 */
export function agentRunUsage(
    slot: NormalizedModel | null | undefined,
    state: RunState,
    meta: AgentUsageMeta,
) {
    const { organizationAndTeamData, ...rest } = meta;
    return {
        ...rest,
        ...agentModelIdentity(slot),
        organizationId: organizationAndTeamData?.organizationId,
        teamId: organizationAndTeamData?.teamId,
        usage: state.usage as TokenUsage,
        steps: state.steps.length,
        finishReason: state.stopReason ?? state.status,
    };
}
