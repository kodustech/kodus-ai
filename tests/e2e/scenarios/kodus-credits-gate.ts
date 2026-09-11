import { http } from "../lib/http.js";
import { logger } from "../lib/log.js";
import {
    auth,
    billingAuth,
    billingBase,
    saveKodusByok,
} from "../lib/kodus-credits.js";
import {
    fetchOrgLicense,
    provisionFreshTrialOrg,
} from "../lib/trial-provision.js";
import type { RunContext, Scenario, TargetContext } from "../lib/types.js";

// "Kodus as the provider" — the API-level contract that the review gate and
// the web rely on, exercised on a FRESH org (no platform keys needed: nothing
// here makes an LLM call):
//   1. billing reports a prepaid balance (`creditBalanceUsd`) on the license;
//   2. a KEYLESS `kodus` credential saves on cloud (the one provider whose
//      credential carries no secret);
//   3. the balance/ledger endpoints answer through the web proxy, and the
//      metering `debit` endpoint is NOT reachable from a browser session;
//   4. a credit-pack checkout resolves to a Stripe URL (test mode).
// The review gate itself (CREDITS_EXHAUSTED) is unit-covered; a live blocked
// review needs a throwaway repo + PR and belongs to the managed-review cell.

type Balance = {
    balanceUsd: number;
    lowThresholdUsd: number;
    markupPct: number;
    packsUsd: number[];
    lifetimePurchasedUsd: number;
    lifetimeDebitedUsd: number;
};

export const kodusCreditsGate: Scenario = {
    id: "kodus-credits-gate",
    title:
        "Kodus credits: license carries a balance, keyless kodus credential saves, balance/ledger/checkout answer, debit is browser-unreachable",
    priority: "P1",
    appliesTo: {
        target: ["cloud"],
        provider: ["github", "github-app"],
        license: ["trial"],
    },
    timeoutSec: 180,
    async run(ctx: RunContext) {
        const log = logger("kodus-credits-gate");
        const target = ctx.target as TargetContext;
        const { email, session } = await provisionFreshTrialOrg(
            ctx,
            "e2e-kodus-credits",
        );

        // 1. The license payload carries the prepaid balance (0 on a fresh org).
        const license = (await fetchOrgLicense(ctx, session)) as Record<
            string,
            unknown
        >;
        ctx.assert(
            typeof license.creditBalanceUsd === "number",
            `validate-org-license must carry creditBalanceUsd (billing ledger deployed?): ${JSON.stringify(license)}`,
        );
        ctx.assert(
            license.creditBalanceUsd === 0,
            `A fresh org starts at 0 credits, got ${license.creditBalanceUsd}`,
        );

        // Precondition: the provider is a private alpha (cloud + the
        // `kodus-provider` flag / the deployment allow-list). On an
        // environment where it is not enabled, the connect path is REFUSED by
        // design — report that as skipped-for-setup instead of a failure, and
        // let the same cell assert the whole contract wherever it IS on.
        const providers = await http<{
            data?: { providers?: Array<{ id?: string }> };
        }>(`${target.apiBaseUrl}/organization-parameters/byok/providers`, {
            method: "GET",
            headers: auth(session),
            timeoutMs: 25_000,
        });
        ctx.assert(
            providers.status === 200,
            `byok/providers must answer 200: HTTP ${providers.status} ${providers.raw.slice(0, 200)}`,
        );
        const kodusOffered = (providers.body?.data?.providers ?? []).some(
            (p) => p.id === "kodus",
        );
        if (!kodusOffered) {
            ctx.skip(
                "the Kodus provider is not enabled on this environment " +
                    "(private alpha: needs API_KODUS_PROVIDER_ALPHA_ORGS or the " +
                    "`kodus-provider` PostHog flag + an alpha release track). " +
                    "The provider being HIDDEN is the correct behavior here.",
            );
        }

        // 2. Keyless kodus credential persists (cloud-only path).
        await saveKodusByok(ctx, session);
        const status = await http<{
            data?: { models?: Array<{ providerId?: string; resolvable?: boolean }> };
        }>(`${target.apiBaseUrl}/organization-parameters/llm-config/status`, {
            method: "GET",
            headers: auth(session),
            timeoutMs: 25_000,
        });
        const kodusModel = status.body?.data?.models?.find(
            (m) => m.providerId === "kodus",
        );
        ctx.assert(
            !!kodusModel,
            `llm-config/status must list the kodus model after save: ${status.raw.slice(0, 300)}`,
        );
        ctx.assert(
            kodusModel!.resolvable === true,
            `A keyless kodus credential must be reported resolvable (it needs no material): ${JSON.stringify(kodusModel)}`,
        );

        const qs = `?organizationId=${encodeURIComponent(session.organizationId)}&teamId=${encodeURIComponent(session.teamId)}`;

        // 3. The browser proxy must not expose ANY /credits/* route: they all
        // take a client-chosen organizationId and billing has no caller auth.
        for (const [path, init] of [
            [
                "/credits/debit",
                {
                    method: "POST",
                    body: {
                        organizationId: session.organizationId,
                        entries: [{ usageKey: "e2e:never", amountUsd: 1 }],
                    },
                },
            ],
            ["/credits/balance" + qs, { method: "GET" }],
            ["/credits/ledger" + qs, { method: "GET" }],
            [
                "/credits/checkout",
                {
                    method: "POST",
                    body: {
                        organizationId: session.organizationId,
                        teamId: session.teamId,
                        creditUsd: 20,
                    },
                },
            ],
        ] as const) {
            const viaProxy = await http(
                `${target.webBaseUrl}/api/proxy/billing${path}`,
                { ...(init as object), headers: auth(session), timeoutMs: 30_000 } as any,
            );
            ctx.assert(
                viaProxy.status === 404,
                `${path.split("?")[0]} must be unreachable through the browser proxy (expected 404, got ${viaProxy.status})`,
            );
        }

        // 4. Billing's own API — balance shape, empty ledger, a real Stripe
        // quote. The browser can no longer reach /credits/* (step 3), so this
        // needs DIRECT billing access. Where the harness has it
        // (BILLING_ADMIN_BASE_URL, e.g. a dev VM), assert it; where it does
        // not, everything above still ran and this part is reported as
        // skipped rather than faked through a route that must 404.
        const billingDirect = process.env.BILLING_ADMIN_BASE_URL?.trim();
        if (!billingDirect) {
            log.warn(
                "BILLING_ADMIN_BASE_URL unset — skipping the direct billing assertions " +
                    "(balance shape, empty ledger, Stripe quote). The product-surface " +
                    "contract above was fully asserted.",
            );
            return {
                email,
                organizationId: session.organizationId,
                billingAsserted: false,
            };
        }

        const balance = await http<Balance>(
            `${billingBase(ctx)}/credits/balance${qs}`,
            { method: "GET", headers: billingAuth(session), timeoutMs: 30_000 },
        );
        ctx.assert(
            balance.status === 200 && balance.body?.balanceUsd === 0,
            `credits/balance must answer 200 with balanceUsd=0: HTTP ${balance.status} ${balance.raw.slice(0, 250)}`,
        );
        ctx.assert(
            Array.isArray(balance.body?.packsUsd) &&
                balance.body!.packsUsd.length > 0 &&
                typeof balance.body?.markupPct === "number",
            `credits/balance must carry packs + markup: ${JSON.stringify(balance.body)}`,
        );

        const ledger = await http<{ entries?: unknown[] }>(
            `${billingBase(ctx)}/credits/ledger${qs}`,
            { method: "GET", headers: billingAuth(session), timeoutMs: 30_000 },
        );
        ctx.assert(
            ledger.status === 200 && Array.isArray(ledger.body?.entries),
            `credits/ledger must answer 200 with entries[]: HTTP ${ledger.status} ${ledger.raw.slice(0, 250)}`,
        );
        ctx.assert(
            ledger.body!.entries!.length === 0,
            `A fresh org has an empty ledger, got ${ledger.body!.entries!.length} entries`,
        );

        const pack = balance.body!.packsUsd[0];
        const checkout = await http<{
            url?: string;
            creditUsd?: number;
            chargeUsd?: number;
        }>(`${billingBase(ctx)}/credits/checkout`, {
            method: "POST",
            headers: billingAuth(session),
            body: {
                organizationId: session.organizationId,
                teamId: session.teamId,
                creditUsd: pack,
            },
            timeoutMs: 40_000,
        });
        ctx.assert(
            checkout.status === 200 &&
                typeof checkout.body?.url === "string" &&
                /^https:\/\/checkout\.stripe\.com\//.test(checkout.body.url),
            `credits/checkout must return a Stripe Checkout URL: HTTP ${checkout.status} ${checkout.raw.slice(0, 250)}`,
        );
        ctx.assert(
            checkout.body!.creditUsd === pack &&
                typeof checkout.body!.chargeUsd === "number" &&
                checkout.body!.chargeUsd! > pack,
            `Quote must charge credit + markup: ${JSON.stringify(checkout.body)}`,
        );

        // Still 0 after quoting — only a PAID session credits the ledger.
        const after = await fetchOrgLicense(ctx, session);
        ctx.assert(
            (after as Record<string, unknown>).creditBalanceUsd === 0,
            `Creating a checkout must not credit the balance: ${JSON.stringify(after)}`,
        );

        return {
            billingAsserted: true,
            email,
            organizationId: session.organizationId,
            teamId: session.teamId,
            pack,
            chargeUsd: checkout.body!.chargeUsd,
            markupPct: balance.body!.markupPct,
        };
    },
};

export default kodusCreditsGate;
