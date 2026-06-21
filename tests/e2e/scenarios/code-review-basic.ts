import { ensureLicenseSeat } from "../lib/onboarding.js";
import type { RunContext, Scenario } from "../lib/types.js";

// Fixture branch pairs per provider. Each entry maps to two branches that
// already exist in the test repo with a deliberate diff between them. The
// scenario opens a FRESH PR from head→base each run, so the
// `validate-new-commits` pipeline stage always treats it as a new review
// (re-triggering on a standing PR gets short-circuited as
// "already reviewed the latest changes").
//
// For GitHub: assumes the repo was forked via
// `scripts/pr-creator/fork-benchmark-repos.sh` into an org owned by the
// test PAT (e.g. `kodus-e2e`). The branch pair below comes from the sentry
// fork. When extending to other providers, populate the corresponding
// entries here once the fixture repos are set up.
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: {
        // Fixture branch deliberately introduces a missing null-check +
        // misleading comment + unsafe `as string` cast on a redirect
        // path (kodus-e2e/tiny-url). Any LLM that is paying attention
        // flags at least one of: (1) the dropped 404 branch, (2) the
        // "we trust resolveCode here" comment that is factually wrong,
        // (3) the type assertion masking an undefined. Was previously
        // `refactor/use-map-storage` — that fixture was intentionally
        // clean ("no behavior change, exercises the pipeline without
        // giving the LLM anything controversial to flag") which made
        // the `findings > 0` assertion flaky against Kimi K2.6 on
        // self-hosted: pipeline ran in 2.6s, found nothing to comment
        // on, scenario timed out at 25min in silence. Cloud LLMs
        // (GPT/Claude) happened to nitpick the refactor and pass, but
        // that was luck, not design.
        head: "bug/missing-null-check",
        base: "main",
    },
    // Placeholders for GitLab / Bitbucket / Azure DevOps — assume the
    // tiny-url fixture repo will be mirrored into those providers under
    // the same path/branches. Good enough for mocked integration tests
    // (they only POST and don't care about the actual remote); won't work
    // against real providers until those mirrors exist.
    gitlab: {
        head: "bug/missing-null-check",
        base: "main",
    },
    bitbucket: {
        head: "bug/missing-null-check",
        base: "main",
    },
    "azure-devops": {
        head: "bug/missing-null-check",
        base: "main",
    },
    // App-installed clone of tiny-url (same branches), instance-scoped
    // via GH_APP_TEST_REPO so the App-bound repo is hit instead of the
    // PAT-bound one.
    "github-app": {
        head: "bug/missing-null-check",
        base: "main",
    },
};

export const codeReviewBasic: Scenario = {
    id: "code-review-basic",
    title: "Kody reviews a PR opened on the configured fixture repo",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "bitbucket", "azure-devops"],
        // `trial` is intentionally NOT here: a standing trial subscription
        // expires after 14 days (no reset endpoint) and broke this scenario
        // every release. Trial coverage moved to fresh-org-per-run scenarios:
        // `trial-entitlement-gate` (fast API gate check) and
        // `trial-managed-review` (real managed-LLM review on a throwaway repo).
        license: ["paid", "license-paid"],
    },
    // Scenario budget must comfortably exceed phase A (600s) + the inner
    // pollForReview budget (1500s) + onboarding + open-PR overhead. 2700s
    // keeps a ~5min cushion so the outer kill never fires before the inner
    // timeout has a chance to surface a meaningful assertion message.
    timeoutSec: 2700,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            "scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)",
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);
        // Self-hosted licensed mode gates reviews per seat; grant the PR
        // author one so the pipeline doesn't skip with USER_NOT_LICENSED.
        await ensureLicenseSeat(ctx.target, session, ctx.provider);

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name} in code-review-basic.ts`,
        );

        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet — add it before enabling this scenario for that provider`,
            );
        }

        const sinceIso = new Date().toISOString();
        const pr = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] code-review-basic ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Auto-closed by the scenario; branches are persistent fixtures and are not deleted.`,
        });

        try {
            // Two-phase wait. Phase A waits for the pipeline to wake up —
            // separates the "worker dequeued the PR and Kody posted a
            // heartbeat" signal from the "LLM found the deliberate bugs"
            // signal. Budget is deliberately generous (600s): under matrix
            // load the GitHub bot's rate-limit gate defers the review job
            // by minutes (it republishes-with-delay until the API bucket
            // resets), so a tight ~60s budget false-flagged "never started"
            // when the review was merely queued behind a rate-limit reset
            // (matrix run 2026-06-12, PR #96: review ran ~5min late, past
            // the old 60s budget, so the cell failed both attempts even
            // though the pipeline was healthy). The morning of 2026-05-21
            // a run sat in silence for 25 min while the test runner
            // assumed nothing happened — in reality the LLM had
            // completed review in 2.6s and decided the clean fixture
            // had nothing to flag. The new fixture (bug/missing-null-
            // check) is no longer clean, but a future "LLM regression
            // produces no findings" can still happen, and we'd rather
            // surface that explicitly than silently fail at the 25min
            // mark indistinguishable from "pipeline never ran".
            //
            // Phase A is github-only for now; other providers skip it
            // until their waitForPipelineStart implementations land.
            let pipelineStartedAt: string | undefined;
            if (ctx.provider.waitForPipelineStart) {
                const started = await ctx.provider.waitForPipelineStart(
                    { number: pr.number },
                    { sinceIso, timeoutSec: 600 },
                );
                pipelineStartedAt = started.startedAt;
            }

            // 25 min — matches per-seat-license-toggle's phase-2 budget.
            // Bumped from 600s on 2026-05-20 after matrix run #3 showed
            // gitlab/bitbucket/azure-devops × license-paid consistently
            // timing out at ~10 min while github passed in 160s and
            // per-seat (1500s budget) succeeded across all 4 providers.
            // Non-github providers genuinely take longer end-to-end —
            // probably a mix of webhook delivery latency and worker queue
            // depth — and the only meaningful signal we lost by extending
            // the budget is "review takes >10min", which we now expose
            // via reviewLatencySec on the evidence record so trends can
            // be observed across runs without re-introducing flakes.
            const pollStartMs = Date.now();
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 1500 },
            );
            const reviewLatencySec = Math.round((Date.now() - pollStartMs) / 1000);

            // Trust per-provider filter (each pollForReview excludes the
            // `<!-- kody-codereview -->` status comments). What survives the
            // filter is a real Kody finding in whatever bucket the provider
            // uses (GitLab puts everything in issueComments because the API
            // has only notes; Bitbucket/Azure use reviewComments; GitHub
            // splits across all three).
            // Distinguish "pipeline ran but produced 0 findings"
            // (LLM regression, since the fixture is a deliberate bug)
            // from "pipeline never ran" (worker / webhook / config
            // problem). Phase A above already separates the second
            // case; here we only get reached if Phase A passed (or
            // the provider doesn't implement Phase A yet).
            const phaseADetail = pipelineStartedAt
                ? `pipeline ack at ${pipelineStartedAt}, then `
                : "";
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                pipelineStartedAt
                    ? `Review pipeline ran (${phaseADetail}heartbeat seen) but produced 0 findings on PR/MR #${pr.number} within ${reviewLatencySec}s. The fixture branch '${fixture!.head}' has deliberate bugs (missing null check, misleading comment, unsafe type cast) — any decent LLM should flag at least one. Suspect: LLM quality regression for the configured model.`
                    : `No real review findings on PR/MR #${pr.number} within timeout (${reviewLatencySec}s)`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
                reviewLatencySec,
                pipelineStartedAt,
                sinceIso,
                review,
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

export default codeReviewBasic;
