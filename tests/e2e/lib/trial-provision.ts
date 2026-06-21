import { http } from "./http.js";
import { login, signUp } from "./onboarding.js";
import type { KodusSession, RunContext, TargetContext } from "./types.js";

// Shared trial-org provisioning used by `trial-entitlement-gate` (API-level
// gate check) and `trial-managed-review` (real managed review on a throwaway
// repo): sign up a brand-new org and start its 14-day managed trial.
//
// Why fresh-org-per-run instead of a standing trial tenant: a cloud
// `/billing/trial` row expires 14 days after creation and there is NO
// trial-reset endpoint (billing exposes only `trial`, `migrate-to-free`,
// `validate-org-license`; re-POSTing `trial` 409s). A long-lived trial tenant
// therefore silently lapses ~2 weeks after seeding — the recurring matrix red.
// A brand-new org is always inside a fresh window.

export const TRIAL_ORG_PASSWORD = "E2eTrial!2026x";

/** Unique, [a-z0-9]-safe slug for throwaway org emails / repo names. Uses
 *  the END of the runId — the head is `YYYY-MM-DDT…` (identical across
 *  same-day runs), the tail is `…<ms>Z-<randomhex>`. */
export function runSlug(runId: string): string {
    return runId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-12);
}

export interface FreshTrialOrg {
    email: string;
    session: KodusSession;
}

/** Sign up a fresh throwaway org and activate its managed (byok:false)
 *  trial. Asserts the billing service actually landed a `trial` row. */
export async function provisionFreshTrialOrg(
    ctx: RunContext,
    emailPrefix: string,
): Promise<FreshTrialOrg> {
    const target = ctx.target as TargetContext;
    // `@kodus.local` matches the throwaway domain the RBAC scenarios
    // already use on cloud QA. Slug from the runId TAIL — the head is the
    // date (collides across same-day runs); the tail carries ms + the
    // random hex suffix.
    const email = `${emailPrefix}-${runSlug(ctx.runId)}@kodus.local`;
    await signUp(target, { email, password: TRIAL_ORG_PASSWORD });
    const session = await login(target, {
        email,
        password: TRIAL_ORG_PASSWORD,
    });

    // Mirrors setup-tenants.ts: byok:false → a managed (Kodus-keys) trial.
    // 409 / "already exists" is idempotent OK — the desired end-state (a
    // valid trial subscription record) is satisfied either way.
    const resp = await http(`${target.webBaseUrl}/api/proxy/billing/trial`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: {
            organizationId: session.organizationId,
            teamId: session.teamId,
            byok: false,
        },
        timeoutMs: 30_000,
    });
    const trialStarted =
        (resp.status >= 200 &&
            resp.status < 300 &&
            (resp.body as { subscriptionStatus?: string })
                ?.subscriptionStatus === "trial") ||
        resp.status === 409 ||
        (resp.status === 400 &&
            /already|trial|existe/i.test(
                (resp.body as any)?.error ??
                    (resp.body as any)?.message ??
                    "",
            ));
    ctx.assert(
        trialStarted,
        `POST /billing/trial did not yield a trial subscription (HTTP ${resp.status}): ${resp.raw.slice(0, 250)}`,
    );

    return { email, session };
}

export interface OrgLicense {
    valid?: boolean;
    subscriptionStatus?: string;
    planType?: string;
    byok?: boolean;
    trialReviewCreditsTotal?: number;
    trialReviewCreditsUsed?: number;
    trialReviewCreditsRemaining?: number;
    trialCreditTier?: string;
}

export interface ConsumeCreditResult {
    allowed: boolean;
    reason?: string;
    alreadyConsumed?: boolean;
    trialReviewCreditsTotal?: number;
    trialReviewCreditsUsed?: number;
    trialReviewCreditsRemaining?: number;
}

/** Calls the billing consume endpoint exactly as the review pipeline does
 *  (LicenseService.consumeTrialReviewCredit). Billing answers 200 when
 *  allowed and 402 (allowed:false) when denied; both carry the credit body,
 *  and `http` does not throw on non-2xx, so we return the body either way. */
export async function consumeTrialReviewCredit(
    ctx: RunContext,
    session: KodusSession,
    usageKey?: string,
): Promise<ConsumeCreditResult> {
    const target = ctx.target as TargetContext;
    const resp = await http<ConsumeCreditResult>(
        `${target.webBaseUrl}/api/proxy/billing/trial-review-credit/consume`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                organizationId: session.organizationId,
                teamId: session.teamId,
                usageKey,
            },
            timeoutMs: 30_000,
        },
    );
    ctx.assert(
        resp.status === 200 || resp.status === 402,
        `consume returned unexpected HTTP ${resp.status}: ${resp.raw.slice(0, 250)}`,
    );
    return resp.body ?? { allowed: false };
}

/** GET the org license exactly the way the backend's entitlement gate does
 *  (PermissionValidationService → validateOrganizationLicense). */
export async function fetchOrgLicense(
    ctx: RunContext,
    session: KodusSession,
): Promise<OrgLicense> {
    const target = ctx.target as TargetContext;
    const url =
        `${target.webBaseUrl}/api/proxy/billing/validate-org-license` +
        `?organizationId=${encodeURIComponent(session.organizationId)}` +
        `&teamId=${encodeURIComponent(session.teamId)}`;
    const resp = await http<OrgLicense>(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        timeoutMs: 30_000,
    });
    ctx.assert(
        resp.status >= 200 && resp.status < 300,
        `GET validate-org-license failed (HTTP ${resp.status}): ${resp.raw.slice(0, 250)}`,
    );
    return resp.body ?? {};
}
