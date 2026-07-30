import { ensureLicenseSeat } from "../lib/onboarding.js";
import { assertHealthyExecution } from "../lib/execution-health.js";
import type { LicenseMode, RunContext, Scenario } from "../lib/types.js";

// Fixture branch pair per provider. Each pair is a persistent head/base
// pre-committed in the test repo with a small but realistic diff. The
// scenario opens an ephemeral PR per run between them so each run gets a
// fresh PR number — the `validate-new-commits` pipeline stage would
// otherwise short-circuit re-runs against a standing PR as "already
// reviewed the latest changes".
//
// We deliberately use a different pair from `code-review-basic.ts` and
// `kody-rules.ts` so the three scenarios can run in parallel without
// GitHub rejecting "second open PR for the same head→base".
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: {
        // Feature add in the tiny-url fixture repo (kodus-e2e/tiny-url):
        // /stats endpoint + per-code hit counter. ~30 lines, two files
        // touched — meaty enough that Kody usually surfaces real findings
        // (paid path observed ~10–11 min end-to-end on Kimi K2.6), but
        // still a realistic PR-sized change. Different head→base from
        // code-review-basic and kody-rules so all three scenarios can
        // have open PRs simultaneously.
        head: "feature/add-stats",
        base: "main",
    },
    gitlab: {
        // Same fixture mirrored to gitlab.com/kodus-e2e/tiny-url.
        head: "feature/add-stats",
        base: "main",
    },
    "azure-devops": {
        // Same fixture mirrored to dev.azure.com/kodustech/kodus-e2e.
        head: "feature/add-stats",
        base: "main",
    },
    bitbucket: {
        // Same fixture mirrored to bitbucket.org/kodustech/tiny-url.
        head: "feature/add-stats",
        base: "main",
    },
    // App-installed clone of tiny-url (kodus-e2e/tiny-url-app); same
    // feature/add-stats branch carried over via the initial mirror.
    "github-app": {
        head: "feature/add-stats",
        base: "main",
    },
};

export const licenseAttribution: Scenario = {
    id: "license-attribution",
    title:
        "Entitlement gate honors the active license/plan: paid reviews; free does not",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "azure-devops", "bitbucket"],
        // `license-free` deliberately excluded: in self-hosted mode there is
        // NO state in which Kodus posts the "trial ended / BYOK / activate
        // plan" notice the scenario asserts on. SelfHostedLicenseService
        // returns either {valid:false} (no/invalid key → Community Edition,
        // reviews fire normally) or {valid:true, …} (licensed, may enforce
        // per-seat). The only `errorType` returned from
        // validateSelfHostedPermissions is USER_NOT_LICENSED, which posts a
        // REACTION via the auto-assign branch — not a notice comment. The
        // "trial ended" comment in validate-prerequisites.stage:681 is only
        // reachable from the cloud path (BYOK_REQUIRED, INVALID_LICENSE,
        // PLAN_LIMIT_EXCEEDED errorTypes), so license-free × self-hosted is
        // structurally unprovable. `free` (cloud post-trial no-BYOK) stays —
        // it triggers the notice path. `trial` is intentionally absent: a
        // standing trial expires after 14 days and there is no reset endpoint,
        // so it broke this scenario every release; trial moved to the
        // fresh-org-per-run scenarios `trial-entitlement-gate` (API gate) and
        // `trial-managed-review` (real managed review on a throwaway repo).
        // The remaining tiers here cover review-positive (paid /
        // community-byok / license-paid) and the blocked path (free).
        license: [
            "free",
            "paid",
            "community-byok",
            "license-paid",
        ],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name} in license-attribution.ts`,
        );
        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        // Self-hosted here only runs license-paid (expectReview); grant the
        // PR author a seat so licensed-mode enforcement doesn't skip it. The
        // cloud free/trial no-review tiers are unaffected (self-hosted-only).
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        // Tiers where the entitlement gate BLOCKS the LLM review. On
        // cloud these tenants are "trial expired without BYOK" — Kody
        // posts a "trial ended / activate plan" notification on the PR
        // instead of running the review pipeline. On self-hosted with
        // no license key (`license-free`), reviews stop similarly when
        // the org never activated a key.
        const noReviewLicenses: LicenseMode[] = ["free", "license-free"];
        const expectReview = !noReviewLicenses.includes(ctx.license);

        const sinceIso = new Date().toISOString();
        const pr = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] license-attribution ${ctx.license} ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} to validate the license=${ctx.license} entitlement gate. Auto-closed by the scenario; branches are persistent fixtures and are not deleted.`,
        });

        try {
            // `paid`/`trial` paths get a 900s poll budget to cover the
            // slowest legitimate review (Kimi K2.6 on tiny-url measures
            // ~10–11 min end-to-end, with variance). Blocked paths only
            // need to confirm Kody posted the license-block notice — that
            // shows up in seconds. A short window also keeps the false-
            // positive surface tight: a gate that fails open and starts
            // a review would still race the poll, but the longer the
            // wait the more likely Kody will post the notice anyway.
            const pollWindow = expectReview ? 900 : 180;
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: pollWindow },
            );

            const sawRealReview =
                review.reviewComments +
                    review.issueComments +
                    review.reviews >
                0;
            const sawLicenseNotice = !!review.licenseBlockedNotice;

            if (expectReview) {
                ctx.assert(
                    sawRealReview,
                    `Expected a real review for license=${ctx.license} but none arrived within ${pollWindow}s. licenseBlockedNotice=${JSON.stringify(review.licenseBlockedNotice)}`,
                );
                ctx.assert(
                    !sawLicenseNotice,
                    `License=${ctx.license} should NOT trigger a trial/BYOK notice, but Kody posted one: ${JSON.stringify(review.licenseBlockedNotice)}`,
                );
                // Execution HEALTH: a licensed review that posts findings can
                // still hide a crashed agent/stage (partial_error). Only the
                // expectReview tier runs the real pipeline, so assert health
                // here (the blocked tier is gated before any execution row).
                await assertHealthyExecution(ctx, session, pr.number);
            } else {
                // Blocked tier — gate must stop the real review pipeline
                // AND Kody should explain why with a notice on the PR.
                // Bare silence (no review, no notice) is a different
                // failure mode (webhook never arrived, pipeline crashed
                // silently, filter regression) and we'd rather fail loud.
                ctx.assert(
                    !sawRealReview,
                    `Expected NO real review for license=${ctx.license} but Kody posted one: ${JSON.stringify(review)}`,
                );
                ctx.assert(
                    sawLicenseNotice,
                    `License=${ctx.license} should have triggered a trial-ended / BYOK / no-license notice from Kody, but the PR has no such comment after ${pollWindow}s. review=${JSON.stringify(review)}`,
                );
            }

            return {
                license: ctx.license,
                expectReview,
                sawRealReview,
                sawLicenseNotice,
                licenseBlockedNotice: review.licenseBlockedNotice,
                review,
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
                sinceIso,
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch (err) {
                // best-effort cleanup — leaving the PR open is recoverable
            }
        }
    },
};

export default licenseAttribution;
