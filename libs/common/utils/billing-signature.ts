import { createHmac } from 'crypto';

/**
 * The signature the billing service requires on its `/credits/*` routes.
 *
 * Those routes move money (a balance, a ledger, a Stripe checkout, a debit)
 * and take the organizationId straight from the request, so billing
 * authenticates its callers with an HMAC over the request itself. The secret
 * is the one both deployments already share for billing's outbound webhooks
 * (`API_BILLING_WEBHOOK_SECRET` here, `KODUS_NOTIFICATION_WEBHOOK_SECRET`
 * there — one value by contract), so nothing new has to be provisioned, and
 * it is signed rather than sent, so it never lands in an access log.
 *
 * The payload is `METHOD\n/path\n<canonical query>\n<timestamp>\n<body>`:
 *   · method + path, so a signature from a balance read cannot be replayed
 *     against the debit route;
 *   · the canonical query (params sorted and re-encoded), because the
 *     GET/DELETE routes read `organizationId`/`teamId` from the query string —
 *     leave it out and one leaked signature reads or mutates ANY org;
 *   · the timestamp, checked by billing against a 5-minute window, so a
 *     signature that leaks stops working instead of being valid forever;
 *   · the exact body bytes that go on the wire, whatever the method (no body
 *     signs the empty string).
 *
 * The counterpart is `src/config/utils/serviceToken.ts` in
 * kodus-service-billing. The web has its own copy of this for its server-side
 * fetches (it cannot import from `libs` at runtime); the two are pinned
 * together by apps/web/.../billing/signature.parity.spec.ts.
 */
export const BILLING_SIGNATURE_HEADER = 'x-kodus-signature';
export const BILLING_TIMESTAMP_HEADER = 'x-kodus-timestamp';

/**
 * The query string as both sides agree to see it: parsed, sorted by name and
 * re-encoded, so a proxy that reorders or re-escapes params cannot cause a
 * 401 while changing a VALUE still invalidates the signature.
 */
export function canonicalBillingQuery(
    query: string | Record<string, unknown> | undefined,
): string {
    const params = new URLSearchParams();
    if (typeof query === 'string') {
        for (const [key, value] of new URLSearchParams(
            query.replace(/^\?/, ''),
        )) {
            params.append(key, value);
        }
    } else if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item === undefined || item === null) continue;
                    params.append(key, String(item));
                }
            } else {
                params.append(key, String(value));
            }
        }
    }
    params.sort();
    return params.toString();
}

export function billingSignaturePayload(args: {
    method: string;
    /** Full path as billing sees it, e.g. `/api/billing/credits/balance`. */
    path: string;
    query?: string | Record<string, unknown>;
    timestamp: string;
    rawBody?: string;
}): string {
    return [
        args.method.toUpperCase(),
        args.path.split('?')[0],
        canonicalBillingQuery(args.query),
        args.timestamp,
        args.rawBody ?? '',
    ].join('\n');
}

/**
 * The headers billing expects, or `{}` when no secret is configured (the
 * routes then answer 500 on billing's side, which is the intended fail-closed
 * behavior — never a silent unsigned call that looks authorized).
 */
export function billingSignatureHeaders(args: {
    secret: string;
    method: string;
    path: string;
    query?: string | Record<string, unknown>;
    rawBody?: string;
    now?: number;
}): Record<string, string> {
    if (!args.secret) return {};
    const method = args.method.toUpperCase();
    const timestamp = String(args.now ?? Date.now());
    // Whatever bytes go on the wire, for EVERY method. A request with no body
    // signs the empty string; a DELETE that DOES carry one has it covered,
    // which the old GET/DELETE special case silently skipped.
    const rawBody = args.rawBody ?? '';
    const signature = createHmac('sha256', args.secret)
        .update(
            billingSignaturePayload({
                method,
                path: args.path,
                query: args.query,
                timestamp,
                rawBody,
            }),
        )
        .digest('hex');
    return {
        [BILLING_SIGNATURE_HEADER]: signature,
        [BILLING_TIMESTAMP_HEADER]: timestamp,
    };
}
