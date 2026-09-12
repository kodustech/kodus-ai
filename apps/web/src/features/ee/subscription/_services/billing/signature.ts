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
    const target = `/api/billing/${path.replace(/^\//, "")}`;
    // Split on the FIRST "?" only: a query value may contain a literal "?"
    // (an unencoded return URL, say), and dropping everything after it would
    // sign a truncated query while billing canonicalizes the whole thing.
    const q = target.indexOf("?");
    const signedPath = q === -1 ? target : target.slice(0, q);
    const query = q === -1 ? "" : target.slice(q + 1);
    return [
        method.toUpperCase(),
        signedPath,
        canonicalBillingQuery(query),
        timestamp,
        rawBody,
    ].join("\n");
};

/** Say it once per process, not once per request: this is a deployment fact. */
let missingSecretWarned = false;

export const billingSignatureHeader = (
    method: string,
    path: string,
    rawBody = "",
    now = Date.now(),
): Record<string, string> => {
    const secret = billingServiceSecret();
    if (!secret) {
        // Unsigned means billing answers 401 (or 500) and `billingFetch`
        // resolves null — a wallet with no balance and nothing in the logs to
        // say why. Name the cause, but only for the routes that actually
        // require a signature: every other billing route is unauthenticated
        // and a warning there would be noise. `console` and not
        // PinoLoggerService because apps/web has no Pino; console is what its
        // server code uses.
        if (!missingSecretWarned && /(^|\/)credits(\/|$)/.test(path)) {
            missingSecretWarned = true;
            console.error(
                "[billing] neither API_CREDITS_SERVICE_TOKEN nor " +
                    "API_BILLING_WEBHOOK_SECRET is set — credit calls will go " +
                    "out unsigned and billing will refuse them",
                { method: method.toUpperCase(), path: path.split("?")[0] },
            );
        }
        return {};
    }
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
