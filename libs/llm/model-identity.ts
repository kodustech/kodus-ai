/**
 * The identity fields a usage/cost record carries for the model a run used —
 * derived from the resolved BYOK slot in ONE place, so no call-site re-derives
 * (and mis-derives) them. This is the drift-prone quartet that used to be
 * hand-copied at every `recordAgentRunUsage` call-site across agents AND
 * code-review; the conversation retry once recorded `model: 'resolved'` (the
 * spec sentinel), and `isByok` has been spelled `!!slot`, `!!byokConfig`, and a
 * decoupled `secondaryByok` flag in different places.
 *
 * Lives in @libs/llm (the kernel) — it depends only on `NormalizedModel` and
 * `getModelName`, both here — so agents, code-review, and observability all
 * import the SAME derivation instead of re-implementing it.
 */
import type { NormalizedModel } from './byok-config';
import { getModelName } from './managed-slot';

export interface ModelIdentity {
    /** `provider:model` for a BYOK slot, the env/managed default name when there
     *  is none. Every reader collapses on ':' (deriveTu, backfill-tu, byok-cost),
     *  so this is the same canonical model either way — a slot-less run is NOT
     *  model-less, it runs on the env/managed default. */
    model: string;
    /** Slot presence: a resolved slot = the org's own key → `type: 'byok'`;
     *  absent → the Kodus env/managed default → `type: 'system'`. */
    isByok: boolean;
    /** Stable attribution ids from the resolved slot (undefined on the
     *  env/managed-default path). Stamped on the usage span so spend attributes
     *  by id, not the versioned response model-name. */
    byokModelId: string | undefined;
    credentialId: string | undefined;
}

/** Derive the model-identity quartet from a resolved slot. The ONE place that
 *  turns a slot (or its absence) into `{ model, isByok, byokModelId,
 *  credentialId }`. Spread it wherever a cost record needs those fields. */
export function agentModelIdentity(
    slot: NormalizedModel | undefined,
): ModelIdentity {
    return {
        model: getModelName(slot),
        isByok: !!slot,
        byokModelId: slot?.byokModelId,
        credentialId: slot?.credentialId,
    };
}
