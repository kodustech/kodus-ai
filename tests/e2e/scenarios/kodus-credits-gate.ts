import { http } from "../lib/http.js";
import { auth, saveKodusByok } from "../lib/kodus-credits.js";
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

        // 3. Balance + ledger through the web proxy; debit is denied there.
        const qs = `?organizationId=${encodeURIComponent(session.organizationId)}&teamId=${encodeURIComponent(session.teamId)}`;
        const balance = await http<Balance>(
            `${target.webBaseUrl}/api/proxy/billing/credits/balance${qs}`,
            { method: "GET", headers: auth(session), timeoutMs: 30_000 },
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
            `${target.webBaseUrl}/api/proxy/billing/credits/ledger${qs}`,
            { method: "GET", headers: auth(session), timeoutMs: 30_000 },
        );
        ctx.assert(
            ledger.status === 200 && Array.isArray(ledger.body?.entries),
            `credits/ledger must answer 200 with entries[]: HTTP ${ledger.status} ${ledger.raw.slice(0, 250)}`,
        );
        ctx.assert(
            ledger.body!.entries!.length === 0,
            `A fresh org has an empty ledger, got ${ledger.body!.entries!.length} entries`,
        );

        const debit = await http(
            `${target.webBaseUrl}/api/proxy/billing/credits/debit`,
            {
                method: "POST",
                headers: auth(session),
                body: {
                    organizationId: session.organizationId,
                    entries: [{ usageKey: "e2e:never", amountUsd: 1 }],
                },
                timeoutMs: 30_000,
            },
        );
        ctx.assert(
            debit.status === 404,
            `credits/debit must be unreachable through the browser proxy (expected 404, got ${debit.status})`,
        );

        // 4. A credit-pack checkout resolves to a Stripe session URL.
        const pack = balance.body!.packsUsd[0];
        const checkout = await http<{
            url?: string;
            creditUsd?: number;
            chargeUsd?: number;
        }>(`${target.webBaseUrl}/api/proxy/billing/credits/checkout`, {
            method: "POST",
            headers: auth(session),
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
