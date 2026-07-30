import {
    fetchOrgLicense,
    provisionFreshTrialOrg,
} from "../lib/trial-provision.js";
import type { RunContext, Scenario } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Trial entitlement gate (cloud-only, API-level, NO webhook).
//
// Fast, precise check that a fresh trial org is entitled to managed reviews:
// sign up a brand-new org (always inside its fresh 14-day window — see
// lib/trial-provision.ts for why a standing trial tenant can't work), start
// its trial, and assert the organization license the gate keys off is exactly
// `valid + subscriptionStatus === 'trial'`. That is the precise input that
// makes permissionValidation.service.ts:168 return `{ allowed: true }` with no
// BYOK required.
//
// This scenario fails in seconds with a billing-level message when the trial
// plumbing breaks; its sibling `trial-managed-review` proves the same
// entitlement end-to-end (real PR → webhook → managed-LLM review) on a
// throwaway repo and takes ~15 min. Keep both: this one localizes failures,
// that one proves the full path.
// ---------------------------------------------------------------------------

export const trialEntitlementGate: Scenario = {
    id: "trial-entitlement-gate",
    title:
        "A fresh trial org is entitled to managed reviews (valid + subscriptionStatus=trial), no BYOK",
    priority: "P0",
    appliesTo: {
        // Cloud-only: the trial subscription model is a Stripe/billing concept
        // that does not exist self-hosted (SelfHostedLicenseService has no
        // trial state — see license-attribution.ts). github is enough; the
        // gate is provider-agnostic (no integration/repo is touched here).
        target: ["cloud"],
        provider: ["github"],
        license: ["trial"],
    },
    timeoutSec: 120,
    async run(ctx: RunContext) {
        const { email, session } = await provisionFreshTrialOrg(
            ctx,
            "e2e-trial-gate",
        );

        const license = await fetchOrgLicense(ctx, session);
        ctx.assert(
            license.valid === true,
            `Expected a fresh trial org to be valid:true, got ${JSON.stringify(license)}`,
        );
        ctx.assert(
            license.subscriptionStatus === "trial",
            `Expected subscriptionStatus='trial' (the state that makes the entitlement gate allow managed reviews with no BYOK), got '${license.subscriptionStatus}'. Full license=${JSON.stringify(license)}`,
        );

        return {
            email,
            organizationId: session.organizationId,
            teamId: session.teamId,
            subscriptionStatus: license.subscriptionStatus,
            valid: license.valid,
            planType: license.planType,
        };
    },
};

export default trialEntitlementGate;
