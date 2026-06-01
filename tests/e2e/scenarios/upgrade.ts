import type { RunContext, Scenario } from "../lib/types.js";

export const upgradeNMinusOneToN: Scenario = {
    id: "upgrade-n-1-to-n",
    title:
        "Self-hosted stack upgraded from N-1 to N preserves state and still reviews PRs",
    priority: "P0",
    appliesTo: {
        target: ["self-hosted"],
        provider: ["github"],
        license: ["license-paid"],
    },
    timeoutSec: 1800,
    async run(ctx: RunContext) {
        // Scenario is a guard: it only makes sense when invoked by the
        // upgrade provisioning script, which seeds a droplet at the
        // previous release tag, exercises it, then upgrades the
        // containers in-place and runs this scenario to confirm the
        // tenant + review pipeline survived. Outside that flow there
        // is nothing to validate, so skip — surfacing this as a FAIL
        // in the normal matrix run was misleading (one "expected"
        // failure poluting the bottom-line PASS count and worrying
        // anyone reading the matrix output).
        if (process.env.UPGRADE_PRE_VALIDATED !== "1") {
            ctx.skip(
                "Not invoked by upgrade provisioning script (UPGRADE_PRE_VALIDATED unset)",
            );
        }

        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const session = await ctx.kodus.login(ctx.tenant!);

        const { triggerId, sinceIso } = await ctx.provider.triggerReviewOnExistingPR(0);
        const prNumber = Number(process.env.GH_TEST_PR_NUMBER ?? "0");
        ctx.assert(prNumber > 0, "GH_TEST_PR_NUMBER is required");

        const review = await ctx.provider.pollForReview(
            { number: prNumber },
            { sinceIso, triggerId, timeoutSec: 600 },
        );

        ctx.assert(
            review.reviewComments + review.issueComments + review.reviews > 0,
            "Post-upgrade review did not arrive — upgrade broke the review pipeline",
        );

        return {
            preUpgradeTag: process.env.UPGRADE_FROM_TAG ?? "unknown",
            postUpgradeTag: process.env.UPGRADE_TO_TAG ?? "unknown",
            tenant: ctx.tenant?.email,
            review,
            triggerId,
            sinceIso,
            note: "Login on the upgraded stack succeeded, meaning the tenant created at N-1 survived migrations.",
            sessionOrg: session.organizationId,
        };
    },
};

export default upgradeNMinusOneToN;
