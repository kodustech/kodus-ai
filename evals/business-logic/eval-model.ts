import type { NormalizedModel } from '@libs/llm/byok-config';

/**
 * The model the Business Logic live specs run on, routed as production routes
 * an org's: a stored BYOK config read by PermissionValidationService and
 * resolved by resolveTaskSlot for the businessValidation task. Set by
 * live-setup.js from `EVAL_MODEL` (evals/business-logic/live.js --model=<id>);
 * undefined when the specs are run without it.
 */
export function evalModel(): NormalizedModel | undefined {
    return (globalThis as { __BR_EVAL_MODEL__?: NormalizedModel })
        .__BR_EVAL_MODEL__;
}
