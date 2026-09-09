import { http } from "./http.js";
import type { KodusSession, RunContext, TargetContext } from "./types.js";

// Helpers for the "Kodus as the provider" scenarios: the keyless `kodus`
// BYOK credential, the prepaid-credit endpoints (through the web proxy, as
// the app uses them), the API's metering journal, and — for a LIVE cell — the
// billing service's admin adjustment reached DIRECTLY (never via the proxy,
// which denies it), so a test can seed and drain a balance without Stripe.

export const auth = (session: KodusSession) => ({
    Authorization: `Bearer ${session.accessToken}`,
});

export const KODUS_E2E_MODEL =
    "fireworks/accounts/fireworks/models/deepseek-v4-flash-0731";

/** Persist a v2 BYOK config whose only model is routed by Kodus (no key). */
export async function saveKodusByok(
    ctx: RunContext,
    session: KodusSession,
    model: string = KODUS_E2E_MODEL,
): Promise<void> {
    const target = ctx.target as TargetContext;
    const configValue = {
        version: 2,
        credentials: [{ id: "e2e-kodus-cred", provider: "kodus" }],
        models: [
            { id: "e2e-kodus-model", credentialId: "e2e-kodus-cred", model },
        ],
        routing: {
            mode: "manual",
            defaultModelId: "e2e-kodus-model",
            taskOverrides: {},
        },
    };
    const save = await http(
        `${target.apiBaseUrl}/organization-parameters/create-or-update`,
        {
            method: "POST",
            headers: auth(session),
            body: { key: "byok_config", configValue },
            timeoutMs: 25_000,
        },
    );
    ctx.assert(
        save.status >= 200 && save.status < 300,
        `Saving a keyless kodus credential must succeed on cloud (HTTP ${save.status}): ${save.raw.slice(0, 250)}`,
    );
}

export type CreditBalance = {
    balanceUsd: number;
    lowThresholdUsd: number;
    markupPct: number;
    packsUsd: number[];
    lifetimePurchasedUsd: number;
    lifetimeDebitedUsd: number;
};

const orgQs = (session: KodusSession) =>
    `?organizationId=${encodeURIComponent(session.organizationId)}&teamId=${encodeURIComponent(session.teamId)}`;

export async function fetchCreditBalance(
    ctx: RunContext,
    session: KodusSession,
): Promise<CreditBalance> {
    const target = ctx.target as TargetContext;
    const resp = await http<CreditBalance>(
        `${target.webBaseUrl}/api/proxy/billing/credits/balance${orgQs(session)}`,
        { method: "GET", headers: auth(session), timeoutMs: 30_000 },
    );
    ctx.assert(
        resp.status === 200 && typeof resp.body?.balanceUsd === "number",
        `credits/balance must answer 200 with a numeric balance: HTTP ${resp.status} ${resp.raw.slice(0, 250)}`,
    );
    return resp.body!;
}

export type LedgerEntry = {
    type: string;
    amountUsd: number;
    balanceAfterUsd: number;
    usageKey: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
};

export async function fetchCreditLedger(
    ctx: RunContext,
    session: KodusSession,
): Promise<LedgerEntry[]> {
    const target = ctx.target as TargetContext;
    const resp = await http<{ entries?: LedgerEntry[] }>(
        `${target.webBaseUrl}/api/proxy/billing/credits/ledger${orgQs(session)}&limit=200`,
        { method: "GET", headers: auth(session), timeoutMs: 30_000 },
    );
    ctx.assert(
        resp.status === 200 && Array.isArray(resp.body?.entries),
        `credits/ledger must answer 200 with entries[]: HTTP ${resp.status} ${resp.raw.slice(0, 250)}`,
    );
    return resp.body!.entries!;
}

export type Charge = {
    spanId: string;
    correlationId?: string;
    prNumber?: number;
    model: string;
    amountUsd: number;
    status: "pending" | "debited" | "unpriced" | "failed";
    spanAt: string;
};

/** The API's metering journal (what each debit came from). */
export async function fetchCreditCharges(
    ctx: RunContext,
    session: KodusSession,
    prNumber?: number,
): Promise<Charge[]> {
    const target = ctx.target as TargetContext;
    const qs = prNumber ? `?prNumber=${prNumber}&limit=500` : "?limit=500";
    const resp = await http<{ data?: { charges?: Charge[] }; charges?: Charge[] }>(
        `${target.apiBaseUrl}/credits/charges${qs}`,
        { method: "GET", headers: auth(session), timeoutMs: 30_000 },
    );
    ctx.assert(
        resp.status === 200,
        `GET /credits/charges must answer 200: HTTP ${resp.status} ${resp.raw.slice(0, 250)}`,
    );
    return resp.body?.data?.charges ?? resp.body?.charges ?? [];
}

/**
 * Admin adjustment on the billing service, reached DIRECTLY (the web proxy
 * denies /credits/adjust on purpose). Needs BILLING_ADMIN_BASE_URL (e.g.
 * http://localhost:3992/api/billing over an SSH tunnel) and
 * BILLING_ADMIN_TOKEN. Only LIVE cells run this — it is how a test seeds a
 * balance without a Stripe checkout and drains it to exercise the gate.
 */
export async function adminAdjustCredits(
    ctx: RunContext,
    session: KodusSession,
    amountUsd: number,
    usageKey: string,
    reason: string,
): Promise<{ applied: boolean; balanceUsd: number }> {
    const base = process.env.BILLING_ADMIN_BASE_URL;
    const adminToken = process.env.BILLING_ADMIN_TOKEN;
    ctx.assert(
        !!base && !!adminToken,
        "kodus-credits live cell needs BILLING_ADMIN_BASE_URL + BILLING_ADMIN_TOKEN (direct billing access)",
    );
    const resp = await http<{ applied: boolean; balanceUsd: number }>(
        `${base!.replace(/\/$/, "")}/credits/adjust`,
        {
            method: "POST",
            body: {
                organizationId: session.organizationId,
                teamId: session.teamId,
                amountUsd,
                usageKey,
                reason,
                adminToken,
            },
            timeoutMs: 30_000,
        },
    );
    ctx.assert(
        resp.status === 200 && typeof resp.body?.balanceUsd === "number",
        `credits/adjust must answer 200: HTTP ${resp.status} ${resp.raw.slice(0, 250)}`,
    );
    return resp.body!;
}

/** Poll until `pred` is true or the budget runs out. */
export async function pollUntilTrue(
    label: string,
    pred: () => Promise<boolean>,
    opts: { timeoutSec: number; intervalSec?: number },
): Promise<boolean> {
    const deadline = Date.now() + opts.timeoutSec * 1000;
    const interval = (opts.intervalSec ?? 15) * 1000;
    while (Date.now() < deadline) {
        if (await pred()) return true;
        await new Promise((r) => setTimeout(r, interval));
    }
    return false;
}
