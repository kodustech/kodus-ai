import { http } from "../lib/http.js";
import { assertHealthyExecution } from "../lib/execution-health.js";
import {
    createThrowawayRepo,
    deleteRepo,
    sweepStaleThrowawayRepos,
} from "../lib/github-repos.js";
import {
    adminAdjustCredits,
    fetchCreditBalance,
    fetchCreditCharges,
    fetchCreditLedger,
    KODUS_E2E_MODEL,
    pollUntilTrue,
    saveKodusByok,
} from "../lib/kodus-credits.js";
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

// "Kodus as the provider" — the WHOLE loop, live:
//   fresh trial org → keyless `kodus` credential (claude-sonnet-5 routed on
//   Kodus's own account) → seed $5 of credits (admin adjust) → real PR review
//   on a throwaway repo → the metering sweep journals the run's spans and
//   debits them → balance drops, ledger shows the PR → drain the balance to 0
//   → `@kody review` again → the review is BLOCKED with the top-up comment.
//
// Needs a target whose API has the Kodus platform keys AND direct access to
// the billing service (BILLING_ADMIN_BASE_URL/TOKEN). Not in the matrices —
// run by hand against a runo/local stack: `pnpm scenario --scenario
// kodus-credits-review --target cloud --provider github --license trial`.

const REPO_PREFIX = "kodus-credits-e2e-";
const FIXTURE = { head: "feature/add-stats", base: "main" };
const SEED_USD = 5;

export const kodusCreditsReview: Scenario = {
    id: "kodus-credits-review",
    title:
        "Kodus credits, live: a Kodus-routed review is metered and debited, and a zero balance blocks the next one",
    priority: "P1",
    appliesTo: {
        target: ["cloud"],
        provider: ["github"],
        license: ["trial"],
    },
    // onboarding (~3-5 min) + 600s pipeline start + 900s review + sweep (~5
    // min) + blocked re-run (~5 min)
    timeoutSec: 3600,
    async run(ctx: RunContext) {
        const target = ctx.target as TargetContext;
        const baseRepo =
            process.env.GH_TEST_REPO_CLOUD ?? "kodus-e2e/tiny-url-cloud";
        const owner = baseRepo.split("/")[0];

        await sweepStaleThrowawayRepos(owner, REPO_PREFIX).catch(() => 0);
        const repoFullName = await createThrowawayRepo(
            baseRepo,
            `${REPO_PREFIX}${runSlug(ctx.runId)}`,
        );

        try {
            const { email, session } = await provisionFreshTrialOrg(
                ctx,
                "e2e-kodus-credits-rev",
            );

            // ── 1. Kodus provider + a seeded balance ─────────────────────
            await saveKodusByok(ctx, session, KODUS_E2E_MODEL);
            const seeded = await adminAdjustCredits(
                ctx,
                session,
                SEED_USD,
                `adjust:e2e:${ctx.runId}:seed`,
                "e2e seed",
            );
            ctx.assert(
                seeded.applied && seeded.balanceUsd === SEED_USD,
                `Seeding must leave balance=${SEED_USD}: ${JSON.stringify(seeded)}`,
            );
            const licenseAfterSeed = (await fetchOrgLicense(
                ctx,
                session,
            )) as Record<string, unknown>;
            ctx.assert(
                licenseAfterSeed.creditBalanceUsd === SEED_USD,
                `validate-org-license must reflect the seeded balance (cache cleared): ${JSON.stringify(licenseAfterSeed)}`,
            );

            // ── 2. Onboard the throwaway repo ────────────────────────────
            const provider = makeProvider("github", "cloud", repoFullName);
            await registerIntegration(target, provider, session);
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

            // ── 3. A REAL review on the Kodus provider ───────────────────
            const sinceIso = new Date().toISOString();
            const pr = await provider.openPRFromBranches!({
                head: FIXTURE.head,
                base: FIXTURE.base,
                title: `[e2e] kodus-credits-review ${ctx.runId.slice(0, 8)}`,
                body: `Automated PR opened by Kodus E2E run ${ctx.runId}: review routed by the Kodus provider (${KODUS_E2E_MODEL}), billed to prepaid credits. Repo is throwaway.`,
            });

            let review;
            let charges: Awaited<ReturnType<typeof fetchCreditCharges>> = [];
            let balanceAfterReview = SEED_USD;
            try {
                if (provider.waitForPipelineStart) {
                    await provider.waitForPipelineStart(
                        { number: pr.number },
                        { sinceIso, timeoutSec: 600 },
                    );
                }
                review = await provider.pollForReview(
                    { number: pr.number },
                    { sinceIso, timeoutSec: 900 },
                );
                ctx.assert(
                    review.reviewComments + review.reviews + review.issueComments >
                        0,
                    `Expected a real review on the Kodus provider, got ${JSON.stringify(review)}`,
                );
                await assertHealthyExecution(ctx, session, pr.number);

                // ── 4. Metering: journaled AND debited ───────────────────
                const debited = await pollUntilTrue(
                    "metering sweep",
                    async () => {
                        charges = await fetchCreditCharges(
                            ctx,
                            session,
                            pr.number,
                        );
                        return (
                            charges.length > 0 &&
                            charges.every((c) => c.status === "debited")
                        );
                    },
                    { timeoutSec: 600, intervalSec: 20 },
                );
                ctx.assert(
                    debited,
                    `Metering sweep must journal and debit the review's spans within 10 min; charges=${JSON.stringify(charges.slice(0, 5))}`,
                );
                ctx.assert(
                    charges.every((c) => c.model === KODUS_E2E_MODEL),
                    `Every charge must be on the routed catalog model: ${JSON.stringify(charges.map((c) => c.model))}`,
                );
                const chargedUsd = charges.reduce((s, c) => s + c.amountUsd, 0);
                ctx.assert(
                    chargedUsd > 0,
                    `The review must have a positive list-price cost, got ${chargedUsd}`,
                );

                const balance = await fetchCreditBalance(ctx, session);
                balanceAfterReview = balance.balanceUsd;
                ctx.assert(
                    balance.balanceUsd < SEED_USD &&
                        Math.abs(SEED_USD - balance.balanceUsd - chargedUsd) < 0.000_01,
                    `Balance must equal seed − charges: seed=${SEED_USD} charges=${chargedUsd} balance=${balance.balanceUsd}`,
                );
                const ledger = await fetchCreditLedger(ctx, session);
                const debits = ledger.filter(
                    (e) =>
                        e.type === "debit" && e.metadata?.prNumber === pr.number,
                );
                ctx.assert(
                    debits.length === charges.length,
                    `Ledger must carry one debit per charge for PR #${pr.number}: debits=${debits.length} charges=${charges.length}`,
                );

                // ── 5. Drain to zero → the next review is blocked ────────
                const drained = await adminAdjustCredits(
                    ctx,
                    session,
                    -balanceAfterReview,
                    `adjust:e2e:${ctx.runId}:drain`,
                    "e2e drain to exercise the gate",
                );
                ctx.assert(
                    Math.abs(drained.balanceUsd) < 0.000_01,
                    `Drain must leave balance 0: ${JSON.stringify(drained)}`,
                );
                const licenseDrained = (await fetchOrgLicense(
                    ctx,
                    session,
                )) as Record<string, unknown>;
                ctx.assert(
                    (licenseDrained.creditBalanceUsd as number) <= 0,
                    `License must report the drained balance: ${JSON.stringify(licenseDrained)}`,
                );

                const { sinceIso: since2 } =
                    await provider.triggerReviewOnExistingPR(pr.number);
                const blocked = await pollUntilTrue(
                    "credits-exhausted comment",
                    async () => {
                        const comments = await listIssueComments(
                            repoFullName,
                            pr.number,
                            since2,
                        );
                        return comments.some((c) =>
                            /Kodus credits are used up/i.test(c),
                        );
                    },
                    { timeoutSec: 420, intervalSec: 15 },
                );
                ctx.assert(
                    blocked,
                    "With a zero balance, `@kody review` must be blocked with the top-up comment within 7 min",
                );
            } finally {
                await provider.closePR(pr).catch(() => undefined);
            }

            return {
                email,
                organizationId: session.organizationId,
                teamId: session.teamId,
                repo: repoFullName,
                pr: pr.number,
                review,
                charges: charges.length,
                chargedUsd: charges.reduce((s, c) => s + c.amountUsd, 0),
                balanceAfterReview,
            };
        } finally {
            await deleteRepo(repoFullName).catch(() => false);
        }
    },
};

/** Issue comments on the PR created after `sinceIso` (bodies only). */
async function listIssueComments(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
): Promise<string[]> {
    const token = process.env.GH_TEST_TOKEN;
    const resp = await http<Array<{ body?: string }>>(
        `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
            },
            timeoutMs: 30_000,
        },
    );
    if (resp.status !== 200 || !Array.isArray(resp.body)) return [];
    return resp.body.map((c) => c.body ?? "");
}

export default kodusCreditsReview;
