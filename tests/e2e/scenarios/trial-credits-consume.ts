import {
    consumeTrialReviewCredit,
    fetchOrgLicense,
    provisionFreshTrialOrg,
} from "../lib/trial-provision.js";
import type { RunContext, Scenario } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Trial review-credit mechanics (cloud-only, API-level, NO webhook).
//
// Fast, deterministic check of the cross-service credit contract that the
// review gate relies on (permissionValidation.service.ts -> billing
// /trial-review-credit/consume). No LLM, no PR — just the billing endpoint:
//   1. a fresh trial carries credits (total === remaining > 0);
//   2. consuming with a usageKey decrements by exactly 1;
//   3. repeating the SAME usageKey is idempotent (no second decrement) — this
//      is what stops a re-reviewed PR from being charged twice;
//   4. consuming past 0 is blocked as TRIAL_REVIEW_CREDITS_EXHAUSTED.
//
// Sibling `trial-managed-review` proves the same gate end-to-end via a real
// webhook review (~15 min); this one localizes credit-accounting bugs in
// seconds. Legacy-trial (NULL credits stay unlimited) is covered by unit tests
// on both services — it needs a NULL credit row which can't be set over the
// remote billing API, so it is intentionally not a matrix cell.
// ---------------------------------------------------------------------------

export const trialCreditsConsume: Scenario = {
    id: "trial-credits-consume",
    title:
        "Trial credits: consume decrements, repeated usageKey is idempotent, exhaustion blocks",
    priority: "P0",
    appliesTo: {
        target: ["cloud"],
        provider: ["github"],
        license: ["trial"],
    },
    timeoutSec: 180,
    async run(ctx: RunContext) {
        const { email, session } = await provisionFreshTrialOrg(
            ctx,
            "e2e-trial-credits",
        );

        const license = await fetchOrgLicense(ctx, session);
        ctx.assert(
            license.valid === true && license.subscriptionStatus === "trial",
            `Fresh org must be a valid trial: ${JSON.stringify(license)}`,
        );

        const total = license.trialReviewCreditsTotal;
        ctx.assert(
            typeof total === "number" && total > 0,
            `A new trial must carry credits (numeric total > 0). license=${JSON.stringify(license)}`,
        );
        ctx.assert(
            license.trialReviewCreditsRemaining === total,
            `A fresh trial should have remaining === total, got remaining=${license.trialReviewCreditsRemaining}, total=${total}`,
        );

        // 1) Consume one credit with a usageKey → decrements by exactly 1.
        const first = await consumeTrialReviewCredit(ctx, session, "e2e:pr-1");
        ctx.assert(
            first.allowed === true &&
                first.trialReviewCreditsRemaining === total! - 1,
            `First consume should allow and leave remaining=${total! - 1}: ${JSON.stringify(first)}`,
        );

        // 2) Same usageKey again → idempotent: no second decrement.
        const repeat = await consumeTrialReviewCredit(ctx, session, "e2e:pr-1");
        ctx.assert(
            repeat.allowed === true &&
                repeat.alreadyConsumed === true &&
                repeat.trialReviewCreditsRemaining === total! - 1,
            `Repeated usageKey must be idempotent (no second decrement): ${JSON.stringify(repeat)}`,
        );

        // 3) Drain the remaining credits with distinct keys.
        let remaining = total! - 1;
        let guard = total! + 2; // hard stop, never loop forever
        for (let i = 2; remaining > 0 && guard-- > 0; i++) {
            const r = await consumeTrialReviewCredit(
                ctx,
                session,
                `e2e:pr-${i}`,
            );
            ctx.assert(
                r.allowed === true,
                `Consume while credits remain must allow: ${JSON.stringify(r)}`,
            );
            remaining = r.trialReviewCreditsRemaining ?? 0;
        }
        ctx.assert(
            remaining === 0,
            `Expected to drain credits to 0, got remaining=${remaining}`,
        );

        // 4) Consuming past 0 is blocked as exhausted.
        const blocked = await consumeTrialReviewCredit(
            ctx,
            session,
            "e2e:pr-over",
        );
        ctx.assert(
            blocked.allowed === false &&
                blocked.reason === "TRIAL_REVIEW_CREDITS_EXHAUSTED",
            `Consuming past 0 must be blocked as exhausted: ${JSON.stringify(blocked)}`,
        );

        return {
            email,
            organizationId: session.organizationId,
            teamId: session.teamId,
            total,
            finalRemaining: blocked.trialReviewCreditsRemaining,
        };
    },
};

export default trialCreditsConsume;
