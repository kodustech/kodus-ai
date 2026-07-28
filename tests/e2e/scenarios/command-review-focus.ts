import type { RunContext, Scenario } from "../lib/types.js";
import { http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { assertHealthyExecution } from "../lib/execution-health.js";

// Mirrors command-review, but posts a steering directive after the command
// (`@kody review focus on ...`). What's under test is the NEW directive path:
// the trailing free-text must (1) not break command detection across providers
// (the parser/handler changes are the regression risk) and (2) still trigger a
// review. Prompt-level steering itself is covered by unit tests; here we guard
// the end-to-end command-with-directive path on every platform.
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

// Free-text directive appended to the command. Phrased to match the fixture's
// storage-refactor diff so the focus is plausible, but the assertion does not
// depend on what the directive steers — only that the command still reviews.
const DIRECTIVE = "focus on the map-based storage logic and its lookups";

export const commandReviewFocus: Scenario = {
    id: "command-review-focus",
    title:
        "Kody re-reviews a PR after `@kody review <directive>` (focus steering) and the trailing text doesn't break the command",
    priority: "P1",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "license-paid"],
    },
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

        // Disable auto-review at the org level so the ONLY review that can
        // happen comes from the command we post (see command-review.ts for the
        // full rationale + the restore-on-cleanup caveat).
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
            title: `[e2e] command-review-focus ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Auto-review disabled — the review can only come from the @kody review command (with a focus directive) this scenario posts below.`,
        });

        try {
            // Sanity wait: if auto-review wasn't actually disabled, a review
            // would land within ~10s; capture the pre-command count as evidence.
            await new Promise((r) => setTimeout(r, 20_000));
            const preCommandSnapshot = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso: new Date(0).toISOString(), timeoutSec: 1 },
            );
            const preCount =
                preCommandSnapshot.reviewComments +
                preCommandSnapshot.issueComments +
                preCommandSnapshot.reviews;

            const command = `@kody review ${DIRECTIVE}`;
            const sinceIso = new Date().toISOString();
            await ctx.provider.postComment(pr.number, command);

            const pollStartMs = Date.now();
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 1500 },
            );
            const reviewLatencySec = Math.round((Date.now() - pollStartMs) / 1000);

            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No review on PR/MR #${pr.number} within ${reviewLatencySec}s after posting "${command}". The trailing focus directive must not break command detection. pre-command findings count was ${preCount}.`,
            );

            // Execution HEALTH, not just output: the focus-directive review can
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
                command,
                directive: DIRECTIVE,
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch {
                /* best-effort */
            }
            // CRITICAL: restore automatedReviewActive=true (see command-review.ts).
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

export default commandReviewFocus;
