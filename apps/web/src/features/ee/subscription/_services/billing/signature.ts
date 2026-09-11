import { createHmac } from "crypto";

/**
 * The signature billing requires on its `/credits/*` routes (money: a
 * balance, a ledger, a Stripe checkout, a debit). Kept in its OWN module with
 * no imports beyond `crypto`, so the parity spec can load it without dragging
 * next-auth into jest — and so the only thing it can drift from is its
 * backend twin, `libs/common/utils/billing-signature.ts`.
 *
 * The secret is the one both deployments already share for billing's outbound
 * webhooks (`API_BILLING_WEBHOOK_SECRET` here,
 * `KODUS_NOTIFICATION_WEBHOOK_SECRET` there — one value by contract), signed
 * rather than sent. Server-side only: the browser proxy denies `/credits/*`.
 */
export const SIGNATURE_HEADER = "x-kodus-signature";
export const TIMESTAMP_HEADER = "x-kodus-timestamp";

const billingServiceSecret = (): string =>
    (process.env.API_CREDITS_SERVICE_TOKEN ?? "").trim() ||
    (process.env.API_BILLING_WEBHOOK_SECRET ?? "").trim();

/**
 * The query string as both sides agree to see it: parsed, sorted by name and
 * re-encoded. A proxy that reorders params cannot cause a 401; changing a
 * VALUE (another org's id) still invalidates the signature.
 *
 * Kept in lockstep with the backend copy in
 * libs/common/utils/billing-signature.ts by signature.parity.spec.ts — the web
 * cannot import from `libs` at runtime.
 */
export const canonicalBillingQuery = (query: string | undefined): string => {
    const params = new URLSearchParams((query ?? "").replace(/^\?/, ""));
    params.sort();
    return params.toString();
};

/**
 * `METHOD\n/path\n<canonical query>\n<timestamp>\n<body>` — the query is
 * signed because billing's GET/DELETE credit routes read organizationId from
 * it, and the timestamp is signed (and checked against a 5-minute window)
 * so a signature that leaks into a log stops working.
 */
export const billingSignaturePayload = (
    method: string,
    path: string,
    timestamp: string,
    rawBody = "",
): string => {
    const [signedPath, query] = `/api/billing/${path.replace(/^\//, "")}`.split(
        "?",
    );
    return [
        method.toUpperCase(),
        signedPath,
        canonicalBillingQuery(query),
        timestamp,
        rawBody,
    ].join("\n");
};

export const billingSignatureHeader = (
    method: string,
    path: string,
    rawBody = "",
    now = Date.now(),
): Record<string, string> => {
    const secret = billingServiceSecret();
    if (!secret) return {};
    const upper = method.toUpperCase();
    const timestamp = String(now);
    const body = upper === "GET" || upper === "DELETE" ? "" : rawBody;
    return {
        [SIGNATURE_HEADER]: createHmac("sha256", secret)
            .update(billingSignaturePayload(upper, path, timestamp, body))
            .digest("hex"),
        [TIMESTAMP_HEADER]: timestamp,
    };
};
