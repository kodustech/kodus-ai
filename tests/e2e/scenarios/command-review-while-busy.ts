import type { RunContext, Scenario } from "../lib/types.js";
import { http } from "../lib/http.js";
import { ensureLicenseSeat } from "../lib/onboarding.js";
import { countExecutions } from "../lib/execution-health.js";
import { pollUntil } from "../providers/base.js";

// Same fixture as command-review — the diff only has to be non-empty. What
// is under test is scheduling, not review quality.
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

const executionsUrl = (ctx: RunContext, teamId: string, prNumber: number) =>
    `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${prNumber}&teamId=${encodeURIComponent(teamId)}&limit=10`;

/**
 * `@kody review` posted while another review already holds the PR must still
 * produce a review (#1700).
 *
 * This is the inverse of command-review, which deliberately waits for the
 * in-flight automation to settle before commanding. That wait is correct for
 * a test and useless to a customer: it hid the fact that a colliding command
 * was refused, marked COMPLETED and never retried, so the request vanished
 * with nothing on the PR.
 *
 * Auto-review stays ENABLED here on purpose. The bug's own repro (auto-review
 * off, command lands inside the skipped run's window) is a ~3s race — shorter
 * than webhook delivery on a fast environment, so it is unhittable on demand
 * and only ever fired on bitbucket, the slowest provider (#1699). Letting the
 * PR-opened automation run a REAL review widens the same window to minutes and
 * makes the collision deterministic everywhere.
 */
export const commandReviewWhileBusy: Scenario = {
    id: "command-review-while-busy",
    title:
        "Kody still reviews after `@kody review` collides with a review already running on the PR",
    priority: "P1",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "github-app", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "license-paid"],
    },
    // Needs room for onboarding + the automation's own review + the deferral
    // backoff (up to ~30min) before the queued command gets its turn.
    timeoutSec: 3600,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            "scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)",
        );

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

        const pr = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] command-review-while-busy ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. The PR-opened review is left to run so the @kody review posted below collides with it.`,
        });

        try {
            // Command only once the automation's review is CONFIRMED in
            // flight. Sleeping a fixed interval is what made the sibling
            // scenario provider-dependent; waiting for the row makes the
            // collision a fact rather than a hope.
            const inFlight = await pollUntil<boolean>(
                async () => {
                    const resp = await http<any>(
                        executionsUrl(ctx, session.teamId, pr.number),
                        {
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                            timeoutMs: 30_000,
                        },
                    );
                    if (resp.status < 200 || resp.status >= 300) return null;
                    return countExecutions(resp.body, pr.number) >= 1
                        ? true
                        : null;
                },
                { intervalSec: 3, timeoutSec: 180 },
            );

            ctx.assert(
                inFlight,
                `No review ever started for PR/MR #${pr.number}, so there was nothing for the command to collide with`,
            );

            await ctx.provider.postComment(pr.number, "@kody review");

            // Two execution rows = the automation's review AND the command's.
            // Before the fix the command was refused and dropped, so this
            // count stayed at 1 forever no matter how long the poll waited.
            //
            // Counting rows rather than asserting new review comments is
            // deliberate: a command review running straight after a
            // successful one has no new commits to analyse, so it can
            // legitimately post nothing while still being a real run.
            const pollStartMs = Date.now();
            const gotSecondReview = await pollUntil<boolean>(
                async () => {
                    const resp = await http<any>(
                        executionsUrl(ctx, session.teamId, pr.number),
                        {
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                            timeoutMs: 30_000,
                        },
                    );
                    if (resp.status < 200 || resp.status >= 300) return null;
                    return countExecutions(resp.body, pr.number) >= 2
                        ? true
                        : null;
                },
                { intervalSec: 15, timeoutSec: 2400 },
            );
            const waitedSec = Math.round((Date.now() - pollStartMs) / 1000);

            ctx.assert(
                gotSecondReview,
                `"@kody review" on PR/MR #${pr.number} never produced a second execution within ${waitedSec}s. ` +
                    `The command collided with the running review and was dropped instead of queued (#1700).`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
                queuedCommandWaitSec: waitedSec,
                command: "@kody review",
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch {
                /* best-effort */
            }
        }
    },
};

export default commandReviewWhileBusy;
