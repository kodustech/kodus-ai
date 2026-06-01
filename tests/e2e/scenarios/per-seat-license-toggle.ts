import { readFileSync } from "node:fs";
import { http, ensureOk } from "../lib/http.js";
import { logger } from "../lib/log.js";
import type {
    ProviderName,
    RunContext,
    Scenario,
} from "../lib/types.js";

const log = logger("per-seat");

// Per-provider head→base fixture branches. Mirrors the convention used by
// the other scenarios (license-attribution, code-review-basic): each
// provider's fixture repo has the same `feature/add-stats` ↔ `main` pair
// already committed with a small but meaningful diff. We deliberately pick
// the SAME pair as license-attribution since both scenarios validate the
// license gate on the same diff shape and can never have open PRs at the
// same instant (sequential runs reuse the persistent branch).
const FIXTURE_BRANCHES: Record<
    ProviderName,
    { head: string; base: string }
> = {
    github: { head: "feature/add-stats", base: "main" },
    "github-app": { head: "feature/add-stats", base: "main" },
    gitlab: { head: "feature/add-stats", base: "main" },
    bitbucket: { head: "feature/add-stats", base: "main" },
    "azure-devops": { head: "feature/add-stats", base: "main" },
};

// Per-seat license gate validates three states on a single tenant with
// seats=1:
//   (1) license activated, no users assigned, auto-assign default OFF →
//       PR must NOT be reviewed (USER_NOT_LICENSED blocks the pipeline).
//   (2) PAT user manually assigned a seat → PR MUST be reviewed.
//   (3) PAT user unassigned again → PR must NOT be reviewed.
//
// We open three sequential PRs from the same persistent head→base fixture
// branch. Each PR gets a fresh number, so the `validate-new-commits` stage
// always treats it as a new review.
//
// Inputs:
//   SH_LICENSE_KEY_PATH   file containing the seats=1 JWT to activate
//                          (defaults to ~/.kodus-dev/license-seats1.jwt)
//
// We deliberately do NOT consume `SH_LICENSE_KEY` directly because we want
// the dev to keep the key in a chmod-600 file, not in their shell env.
//
// Cross-provider: the scenario reads `userGitId` from
// `provider.currentUserId()` and the gitTool string from
// `provider.licenseGitTool()`. Each provider returns the exact id format
// Kodus stores as `pullRequest.user.id` in the webhook handler:
//   * github / gitlab: numeric id from /user (stringified)
//   * bitbucket: uuid from /2.0/user with `{}` stripped (sanitizeUUID)
//   * azure-devops: authenticatedUser.id GUID from connectionData
export const perSeatLicenseToggle: Scenario = {
    id: "per-seat-license-toggle",
    title:
        "Per-seat license gate: review fires only when the PR author has a seat",
    priority: "P0",
    appliesTo: {
        target: ["self-hosted"],
        provider: ["github", "gitlab", "bitbucket", "azure-devops"],
        license: ["license-paid"],
    },
    // Outer budget: 1500s assigned-phase + 2× 120s unassigned + ~300s
    // onboarding (LLM rule-gen on first run) = ~33 min worst-case. Round
    // up to 40 min so a hung phase fails the scenario before the cell
    // timeout, instead of letting the runner kill mid-poll.
    timeoutSec: 2400,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");
        const baseUrl = ctx.target.apiBaseUrl;

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name}`,
        );
        ctx.assert(
            !!ctx.provider.openPRFromBranches,
            `Provider ${ctx.provider.name} does not implement openPRFromBranches`,
        );

        const jwtPath =
            process.env.SH_LICENSE_KEY_PATH ??
            `${process.env.HOME}/.kodus-dev/license-seats1.jwt`;
        const licenseJwt = readFileSync(jwtPath, "utf-8")
            .replace(/\s+/g, "");
        ctx.assert(
            licenseJwt.split(".").length === 3,
            `License JWT at ${jwtPath} does not look like a 3-part token`,
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);

        const authHeader = {
            Authorization: `Bearer ${session.accessToken}`,
        };

        // Activate the seats=1 license on this tenant's org. Idempotent —
        // POST /license/activate just overwrites the organization parameter.
        const activate = await http<{ data: { valid: boolean; seats?: number } }>(
            `${baseUrl}/license/activate`,
            {
                method: "POST",
                headers: authHeader,
                body: { licenseKey: licenseJwt },
                timeoutMs: 20_000,
            },
        );
        ensureOk(activate, "per-seat:activate");
        ctx.assert(
            activate.body.data?.valid === true,
            `License activate returned valid=false: ${activate.raw.slice(0, 300)}`,
        );

        // Resolve the PAT user's id in the exact format Kodus stores on the
        // webhook payload (per-provider; see Provider.currentUserId comment).
        const userId = await ctx.provider.currentUserId();
        ctx.assert(
            userId.length > 0,
            `Provider ${ctx.provider.name} returned an empty currentUserId`,
        );
        const gitTool = ctx.provider.licenseGitTool();

        try {
            // Force `assignedUsers = []` from the start. POST /license/assign
            // with licenseStatus=inactive is idempotent — if the user isn't in
            // the list it's a no-op.
            await toggleSeat(baseUrl, authHeader, userId, gitTool, "inactive");
            await assertSeatCount(baseUrl, authHeader, 0, ctx);
            const usersBeforePhase1 = await fetchSeats(baseUrl, authHeader);

            const phase1 = await runReviewPhase(ctx, fixture, {
                label: "unassigned-before",
                expectReview: false,
                pollTimeoutSec: 120,
                seatsAtStart: usersBeforePhase1,
            });

            await toggleSeat(baseUrl, authHeader, userId, gitTool, "active");
            await assertSeatCount(baseUrl, authHeader, 1, ctx);
            const usersBeforePhase2 = await fetchSeats(baseUrl, authHeader);

            const phase2 = await runReviewPhase(ctx, fixture, {
                label: "assigned",
                expectReview: true,
                // Measured per-provider review duration on tiny-url + Kimi K2.6:
                //   bitbucket ~10 min, github/azure ~14 min, gitlab 14–15 min
                // with variance from sandbox cold-start + LLM API latency.
                // A 900s budget passed gitlab on a fast run but missed it on a
                // slow run (15 min exact) — a real flake source. Bump to 1500s
                // (25 min) so the slowest legitimate review still completes
                // with margin; anything longer signals a real pipeline hang
                // and should fail loudly, not be retried.
                pollTimeoutSec: 1500,
                seatsAtStart: usersBeforePhase2,
            });

            await toggleSeat(baseUrl, authHeader, userId, gitTool, "inactive");
            await assertSeatCount(baseUrl, authHeader, 0, ctx);
            const usersBeforePhase3 = await fetchSeats(baseUrl, authHeader);

            const phase3 = await runReviewPhase(ctx, fixture, {
                label: "unassigned-after",
                expectReview: false,
                pollTimeoutSec: 120,
                seatsAtStart: usersBeforePhase3,
            });

            return {
                userGitId: userId,
                userIdType: typeof userId,
                gitTool,
                phases: [phase1, phase2, phase3],
            };
        } finally {
            // Restore droplet to "no license active" so subsequent cells
            // (gitlab/bitbucket/azure × license-paid, or github × license-free)
            // don't inherit the seats=1 + user-unassigned state and skip every
            // review with "User Not Licensed". Persisting an invalid key makes
            // validateOrganizationLicense() return valid=false, which on
            // self-hosted means `allowed=true` (Community Edition) — no
            // per-seat enforcement. See permissionValidation.service.ts:302.
            // Best-effort: a failure here would mask the real test result, so
            // we swallow it and only log.
            try {
                await http(
                    `${baseUrl}/license/activate`,
                    {
                        method: "POST",
                        headers: authHeader,
                        body: { licenseKey: "" },
                        timeoutMs: 10_000,
                    },
                );
            } catch (err) {
                log.info(
                    `teardown: failed to clear license (next cell may inherit seats=1): ${String(err)}`,
                );
            }
        }
    },
};

async function toggleSeat(
    baseUrl: string,
    authHeader: Record<string, string>,
    gitId: string,
    gitTool: string,
    licenseStatus: "active" | "inactive",
): Promise<void> {
    const resp = await http<{ data: { successful: unknown[]; failed: unknown[] } }>(
        `${baseUrl}/license/assign`,
        {
            method: "POST",
            headers: authHeader,
            body: {
                users: [{ gitId, gitTool, licenseStatus }],
            },
            timeoutMs: 15_000,
        },
    );
    ensureOk(resp, `per-seat:toggleSeat:${licenseStatus}`);
}

async function assertSeatCount(
    baseUrl: string,
    authHeader: Record<string, string>,
    expected: number,
    ctx: RunContext,
): Promise<void> {
    const resp = await http<{ data: Array<{ git_id: string }> }>(
        `${baseUrl}/license/users`,
        { headers: authHeader, timeoutMs: 15_000 },
    );
    ensureOk(resp, "per-seat:listSeats");
    const count = resp.body.data?.length ?? 0;
    ctx.assert(
        count === expected,
        `Expected ${expected} licensed user(s) but got ${count}: ${resp.raw.slice(0, 300)}`,
    );
}

async function fetchSeats(
    baseUrl: string,
    authHeader: Record<string, string>,
): Promise<Array<{ git_id: string; type: string }>> {
    const resp = await http<{ data: Array<{ git_id: string }> }>(
        `${baseUrl}/license/users`,
        { headers: authHeader, timeoutMs: 15_000 },
    );
    if (resp.status < 200 || resp.status >= 300) return [];
    return (resp.body.data ?? []).map((u) => ({
        git_id: u.git_id,
        type: typeof u.git_id,
    }));
}

async function runReviewPhase(
    ctx: RunContext,
    fixture: { head: string; base: string },
    opts: {
        label: string;
        expectReview: boolean;
        pollTimeoutSec: number;
        seatsAtStart?: Array<{ git_id: string; type: string }>;
    },
): Promise<Record<string, unknown>> {
    const sinceIso = new Date().toISOString();
    const pr = await ctx.provider.openPRFromBranches!({
        head: fixture.head,
        base: fixture.base,
        title: `[e2e] per-seat ${opts.label} ${ctx.runId.slice(0, 8)}`,
        body: `Automated PR for per-seat license test (phase: ${opts.label}). Run ${ctx.runId}.`,
    });
    try {
        const review = await ctx.provider.pollForReview(
            { number: pr.number },
            { sinceIso, timeoutSec: opts.pollTimeoutSec },
        );
        const sawReview =
            review.reviewComments + review.issueComments + review.reviews > 0;
        let blockSignalSeen: boolean | undefined;
        if (opts.expectReview) {
            ctx.assert(
                sawReview,
                `[${opts.label}] expected a review on PR #${pr.number} within ${opts.pollTimeoutSec}s but saw none`,
            );
        } else {
            ctx.assert(
                !sawReview,
                `[${opts.label}] expected NO review on PR #${pr.number} but saw: ${JSON.stringify(review)}`,
            );
            // Adherence: "no review comment" alone is a weak negative — a lost
            // or mis-routed webhook produces the same silence. Require the
            // POSITIVE block signal (Kody's 👎 from validate-prerequisites'
            // USER_NOT_LICENSED path) so the assertion proves the seat gate
            // actually fired. By now we've already polled the full review
            // budget with no review, so the 👎 (posted within seconds of the
            // webhook) is present and the detector returns promptly. Providers
            // that don't implement the detector keep the legacy absence check.
            if (ctx.provider.pollForLicenseBlock) {
                blockSignalSeen = await ctx.provider.pollForLicenseBlock(
                    { number: pr.number },
                    { sinceIso, timeoutSec: 60 },
                );
                ctx.assert(
                    blockSignalSeen,
                    `[${opts.label}] no review appeared AND no 👎 license-block signal on PR #${pr.number} within timeout — cannot confirm the seat gate blocked the review (a lost/mis-routed webhook would look identical). This is the failure shape that masked the seat-enforcement regression.`,
                );
            }
        }
        return {
            phase: opts.label,
            prNumber: pr.number,
            prUrl: pr.url,
            expectReview: opts.expectReview,
            sawReview,
            blockSignalSeen,
            review,
            seatsAtStart: opts.seatsAtStart,
        };
    } finally {
        try {
            await ctx.provider.closePR(pr);
        } catch {
            // Best-effort cleanup — leaving the PR open is recoverable.
        }
    }
}

export default perSeatLicenseToggle;
