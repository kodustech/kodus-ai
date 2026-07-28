import type { RunContext, Scenario } from "../lib/types.js";
import { http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { assertHealthyExecution } from "../lib/execution-health.js";

// Same fixture branches as code-review-basic. The diff doesn't matter
// for the command-review path — what's under test is whether posting
// `@kody review` on an EXISTING (already-opened) PR triggers a fresh
// review pipeline run, not whether the LLM finds anything in this
// particular diff. The diff just has to be non-empty so the review
// has something to chew on.
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: { head: "refactor/use-map-storage", base: "main" },
    "github-app": { head: "refactor/use-map-storage", base: "main" },
    gitlab: { head: "refactor/use-map-storage", base: "main" },
    bitbucket: { head: "refactor/use-map-storage", base: "main" },
    "azure-devops": { head: "refactor/use-map-storage", base: "main" },
};

export const commandReview: Scenario = {
    id: "command-review",
    title:
        "Kody re-reviews a PR after the user posts `@kody review` (or `@kody start-review`)",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "bitbucket", "azure-devops"],
        // `trial` dropped here for the same reason as code-review-basic: a
        // standing trial expires after 14 days. Trial is covered by the
        // fresh-org scenarios `trial-entitlement-gate` + `trial-managed-review`;
        // `paid` covers the command review path.
        license: ["paid", "license-paid"],
    },
    // Same envelope as code-review-basic: needs room for onboarding +
    // disable-auto-review setup + open PR + post-comment +
    // pollForReview (1500s).
    timeoutSec: 1800,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            "scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)",
        );

        const baseUrl = ctx.target.apiBaseUrl;
        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        // The @kody review command still runs through the prerequisites
        // gate; on licensed self-hosted the PR author needs a seat.
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name}`,
        );
        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        // Critical: disable automatic review at the org level. Without
        // this, when we open the PR the auto-review pipeline fires
        // immediately and the `@kody review` we post seconds later
        // would race with (or be confused with) the auto-review. By
        // forcing automatedReviewActive=false up front, the ONLY way
        // a review can happen on this PR is via the command — which
        // is exactly what we want to test.
        //
        // validate-prerequisites.stage.ts:707-744 reads
        // `parameterConfig.configs.automatedReviewActive` after the
        // repo override; setting it false at the org level is enough
        // because no repo override is configured during onboarding.
        const setConfig = await http(
            `${baseUrl}/parameters/create-or-update-code-review`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${session.accessToken}`,
                },
                body: {
                    organizationAndTeamData: { teamId: session.teamId },
                    configValue: { automatedReviewActive: false },
                },
                timeoutMs: 20_000,
            },
        );
        ctx.assert(
            setConfig.status >= 200 && setConfig.status < 300,
            `Could not disable auto-review: HTTP ${setConfig.status} ${setConfig.raw.slice(0, 200)}`,
        );

        const pr = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] command-review ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Auto-review disabled — the review on this PR can only come from the @kody review command this scenario posts below.`,
        });

        try {
            // Brief sanity wait: if auto-review wasn't actually
            // disabled (config didn't land for some reason), Kody would
            // start reviewing the freshly-opened PR within ~10s. We
            // give it 20s to surface that bug. If a review DOES land
            // here we still proceed, because:
            //   - pollForReview after the command uses a fresh sinceIso
            //     timestamp, so older reviews aren't counted; and
            //   - we capture the pre-command review count as evidence
            //     so a release engineer can confirm "the command
            //     review came AFTER the command, not before".
            await new Promise((r) => setTimeout(r, 20_000));
            const preCommandSnapshot = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso: new Date(0).toISOString(), timeoutSec: 1 },
            );
            const preCount =
                preCommandSnapshot.reviewComments +
                preCommandSnapshot.issueComments +
                preCommandSnapshot.reviews;

            // Post the trigger comment AFTER we've snapshot pre-state.
            // The webhook handlers detect this exact pattern (see
            // libs/common/utils/codeManagement/codeCommentMarkers.ts:48
            // KODY_REVIEW_COMMAND_PATTERN = /^\s*@kody\s+(start-review|review)\b/i).
            const sinceIso = new Date().toISOString();
            await ctx.provider.postComment(pr.number, "@kody review");

            const pollStartMs = Date.now();
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 1500 },
            );
            const reviewLatencySec = Math.round((Date.now() - pollStartMs) / 1000);

            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No review findings on PR/MR #${pr.number} within ${reviewLatencySec}s after posting "@kody review". pre-command findings count was ${preCount}.`,
            );

            // Execution HEALTH, not just output: a command-triggered review can
            // post findings while an agent/stage crashed (partial_error).
            // Assert the execution settled `success`.
            const executionStatus = await assertHealthyExecution(
                ctx,
                session,
                pr.number,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
                preCommandFindings: preCount,
                reviewLatencySec,
                executionStatus,
                command: "@kody review",
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch {
                /* best-effort */
            }
            // CRITICAL: restore automatedReviewActive=true. Without this,
            // any cell that runs command-review followed by another
            // scenario on the same tenant has auto-review SILENTLY
            // skipped at validate-config.stage.ts:486 — the next PR
            // opens, the webhook arrives, validate-config sees
            // automatedReviewActive=false and returns canProceed=false
            // with NO comment posted on the PR. The downstream scenario
            // looks like a flaky review timeout, but the tenant is
            // permanently broken until automatedReviewActive is flipped
            // back to true. Discovered 2026-05-20 on the github-app
            // smoke (PRs #3, #4, #5 all silently skipped after PR #2's
            // command-review left the config disabled).
            try {
                await http(
                    `${baseUrl}/parameters/create-or-update-code-review`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${session.accessToken}`,
                        },
                        body: {
                            organizationAndTeamData: {
                                teamId: session.teamId,
                            },
                            configValue: { automatedReviewActive: true },
                        },
                        timeoutMs: 20_000,
                    },
                );
            } catch {
                /* best-effort cleanup */
            }
        }
    },
};

export default commandReview;
