/**
 * BYOK managed/trial default-model constants + the "who pays → which default"
 * decision. Split out of byok-to-vercel.ts (Wave 4, SRP) so the entitlement
 * decision has one home, independent of the slot→model adapter. Re-exported from
 * byok-to-vercel.ts for back-compat.
 */
import { BYOKProvider } from '@libs/llm/model-providers';

/**
 * The Kodus-funded model for the trial / no-BYOK (cloud) flow — the SINGLE
 * source of truth for the managed default id. Every entitlement flow that forces
 * "Kodus pays" (code-review trial/demo, Kody Rules generation, reference
 * detection, PR summary) references this instead of re-typing the id.
 */
export const KODUS_DEFAULT_MODEL =
    'accounts/fireworks/models/deepseek-v4-flash-0731';

/**
 * Default model config when no BYOK is configured.
 */
export const KODUS_TRIAL_MODEL =
    'accounts/fireworks/models/deepseek-v4-flash-0731';

export const DEFAULT_MODEL = {
    provider: BYOKProvider.OPENAI_COMPATIBLE,
    model: KODUS_TRIAL_MODEL,
};

/**
 * The `defaultModelOverride` to force for an entitlement flow that must run on
 * Kodus's dime (the 14-day subscription trial OR the anonymous public demo),
 * or `undefined` when the caller should fall through to the production/env
 * default. The SINGLE place this "who pays → which default" decision lives, so
 * a new trial signal (or a change to the trial model) touches one function, not
 * every consumer that used to inline `subscriptionStatus === 'trial' ? … `.
 * Any BYOK config still wins over this at the resolver.
 */
export function trialDefaultModel(params: {
    subscriptionStatus?: string;
    /** Anonymous public demo (try.kodus.io) — same Kodus-funded default. */
    isTrialMode?: boolean;
}): string | undefined {
    return params.subscriptionStatus === 'trial' || params.isTrialMode
        ? KODUS_TRIAL_MODEL
        : undefined;
}
