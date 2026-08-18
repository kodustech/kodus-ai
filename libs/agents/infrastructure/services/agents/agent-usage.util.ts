/**
 * Assembles the full `recordAgentRunUsage` payload for a RunState-based agent
 * run (conversation / business-rules): the model-identity quartet from the
 * slot + usage/steps/finishReason from the RunState. The model-identity
 * derivation itself lives in @libs/llm (`agentModelIdentity`) so agents,
 * code-review, and observability share ONE derivation.
 *
 * `recordAgentRunUsage` owns the span/attribute schema; this owns the per-run
 * value assembly. Kept in @libs/agents (not the harness) so the engine stays
 * observability-agnostic — RunState/TokenUsage are imported type-only.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import { agentModelIdentity } from '@libs/llm/model-identity';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type {
    RunState,
    TokenUsage,
} from '@libs/agent-harness/domain/contracts/run-state.contract';

export { agentModelIdentity } from '@libs/llm/model-identity';

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
    slot: NormalizedModel | undefined,
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
