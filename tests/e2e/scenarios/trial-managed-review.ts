import {
    createThrowawayRepo,
    deleteRepo,
    sweepStaleThrowawayRepos,
} from "../lib/github-repos.js";
import {
    finishOnboarding,
    registerIntegration,
    registerRepo,
} from "../lib/onboarding.js";
import {
    fetchOrgLicense,
    provisionFreshTrialOrg,
    runSlug,
} from "../lib/trial-provision.js";
import type { RunContext, Scenario, TargetContext } from "../lib/types.js";
import { makeProvider } from "../providers/index.js";

// ---------------------------------------------------------------------------
// Trial managed review (cloud × github × trial, one cell).
//
// The ONLY matrix cell that runs a review on Kodus-MANAGED LLM keys — what a
// real trial (and paid) customer gets in prod. Every other review-running
// cell is BYOK (`paid` is seeded as free_byok by decision — see
// setup-tenants.ts:304 — and `community-byok` is BYOK by definition), so
// without this scenario the managed path has zero E2E coverage.
//
// Why throwaway org AND throwaway repo per run:
//   * org: a `/billing/trial` row expires in 14 days with no reset endpoint,
//     so a standing trial tenant rots ~2 weeks after seeding (the recurring
//     matrix red). A fresh org is always inside a fresh window.
//   * repo: cloud resolves a PR webhook to the FIRST IntegrationConfig with
//     an active code-review automation on that repo
//     (webhook-context.service.ts), so a fresh org sharing the standing
//     trial repo gets its review intercepted by a stale org. The fresh org
//     must exclusively own its repo — mirrored from the base fixture so the
//     committed branch pairs come along.
//
// Cost note: each run burns one managed-LLM review on Kodus's own keys.
// That's the point — it's the path under test — but it's why this exists as
// ONE scenario instead of re-adding `trial` to all three review scenarios.
//
// Cleanup: closes the PR and deletes the repo (needs `delete_repo` on
// GH_TEST_TOKEN; tolerated if absent). A start-of-run sweep removes >24h-old
// leftovers from crashed runs.
// ---------------------------------------------------------------------------

const REPO_PREFIX = "tiny-url-trial-e2e-";

// Same head/base pair license-attribution uses: a persistent committed diff
// (/stats endpoint, ~30 lines) meaty enough that Kody reliably surfaces
// SOMETHING. The mirror copies all branches, and the repo is exclusive to
// this run, so there is no open-PR collision with other scenarios.
const FIXTURE = { head: "feature/add-stats", base: "main" };

export const trialManagedReview: Scenario = {
    id: "trial-managed-review",
    title:
        "A fresh trial org gets a REAL managed-LLM review (no BYOK) on its own throwaway repo",
    priority: "P0",
    appliesTo: {
        target: ["cloud"],
        provider: ["github"],
        license: ["trial"],
    },
    // Onboarding (~3-5 min incl. kody-rules generation) + 600s pipeline-start
    // budget + 900s review poll.
    timeoutSec: 2400,
    async run(ctx: RunContext) {
        const target = ctx.target as TargetContext;
        const baseRepo =
            process.env.GH_TEST_REPO_CLOUD ?? "kodus-e2e/tiny-url-cloud";
        const owner = baseRepo.split("/")[0];

        // Best-effort: clear >24h-old leftovers from crashed prior runs so
        // throwaway repos don't accumulate when the PAT can delete them.
        await sweepStaleThrowawayRepos(owner, REPO_PREFIX).catch(() => 0);

        const repoFullName = await createThrowawayRepo(
            baseRepo,
            `${REPO_PREFIX}${runSlug(ctx.runId)}`,
        );

        try {
            const { email, session } = await provisionFreshTrialOrg(
                ctx,
                "e2e-trial-rev",
            );

            // Sanity gate before spending 15 min on the review poll: the org
            // must actually be in the state the entitlement gate allows.
            const license = await fetchOrgLicense(ctx, session);
            ctx.assert(
                license.valid === true &&
                    license.subscriptionStatus === "trial",
                `Fresh org is not in trial state (valid=${license.valid}, subscriptionStatus='${license.subscriptionStatus}') — review would be blocked for the wrong reason. license=${JSON.stringify(license)}`,
            );

            // Provider bound to the throwaway repo: clone URL, /repos/*,
            // webhook listing and PR surface all point at it.
            const provider = makeProvider("github", "cloud", repoFullName);

            await registerIntegration(target, provider, session);

            // The freshly-minted repo can take a little while to appear in
            // the integration's available-repos listing (GitHub propagation
            // after create + Kodus-side listing). Observed live: 19s after
            // creation the repo was still absent. Retry the lookup for up to
            // ~2 min before declaring failure; any OTHER registerRepo error
            // rethrows immediately.
            let repo: Awaited<ReturnType<typeof registerRepo>> | undefined;
            for (let attempt = 1; ; attempt++) {
                try {
                    repo = await registerRepo(target, provider, session);
                    break;
                } catch (err) {
                    const msg = (err as Error).message;
                    if (
                        attempt >= 8 ||
                        !/not in integration's available list/.test(msg)
                    ) {
                        throw err;
                    }
                    await new Promise((r) => setTimeout(r, 15_000));
                }
            }
            await finishOnboarding(target, session, repo!);

            const sinceIso = new Date().toISOString();
            ctx.assert(
                provider.openPRFromBranches,
                "github provider must implement openPRFromBranches",
            );
            const pr = await provider.openPRFromBranches!({
                head: FIXTURE.head,
                base: FIXTURE.base,
                title: `[e2e] trial-managed-review ${ctx.runId.slice(0, 8)}`,
                body: `Automated PR opened by Kodus E2E run ${ctx.runId} to validate that a fresh trial org receives a managed-LLM review. Repo is throwaway and deleted by the scenario.`,
            });

            try {
                // Phase A — fail fast (~2 min) if the webhook never reached
                // the fresh org, instead of burning the whole 900s budget.
                // Distinguishes "webhook/org-routing broke" from "pipeline
                // ran but produced nothing".
                if (provider.waitForPipelineStart) {
                    // Generous start budget: the GitHub rate-limit gate can
                    // defer the review job by minutes under matrix load (see
                    // code-review-basic).
                    await provider.waitForPipelineStart(
                        { number: pr.number },
                        { sinceIso, timeoutSec: 600 },
                    );
                }

                // Phase B — same 900s budget license-attribution gave the
                // trial path (slowest legitimate managed review observed
                // ~10-11 min end-to-end).
                const review = await provider.pollForReview(
                    { number: pr.number },
                    { sinceIso, timeoutSec: 900 },
                );

                const sawRealReview =
                    review.reviewComments +
                        review.issueComments +
                        review.reviews >
                    0;
                ctx.assert(
                    sawRealReview,
                    `Expected a real managed-LLM review on the fresh trial org but none arrived within 900s. licenseBlockedNotice=${JSON.stringify(review.licenseBlockedNotice)}`,
                );
                ctx.assert(
                    !review.licenseBlockedNotice,
                    `Trial must NOT trigger a BYOK/trial-ended notice, but Kody posted one: ${JSON.stringify(review.licenseBlockedNotice)}`,
                );

                return {
                    email,
                    organizationId: session.organizationId,
                    repoFullName,
                    prNumber: pr.number,
                    prUrl: pr.url,
                    review,
                    subscriptionStatus: license.subscriptionStatus,
                };
            } finally {
                try {
                    await provider.closePR(pr);
                } catch {
                    // best-effort — the repo is deleted right after anyway
                }
            }
        } finally {
            await deleteRepo(repoFullName).catch(() => false);
        }
    },
};

export default trialManagedReview;
