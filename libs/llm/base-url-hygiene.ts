/**
 * Base-URL hygiene — catch the endpoint path pasted into the BASE url.
 *
 * A provider SDK builds its request as `baseURL + <its own path>`
 * (`/chat/completions` for the OpenAI protocol, `/v1/messages` for Anthropic).
 * When a user copies the full endpoint out of a provider's cURL example into the
 * "Base URL" field, the path is appended a SECOND time and every call 404s:
 *
 *   stored   https://api.groq.com/openai/v1/chat/completions
 *   request  https://api.groq.com/openai/v1/chat/completions/chat/completions
 *
 * Nothing downstream can recover from this — the key is valid, the model is
 * valid, the URL resolves, and reviews just fail. It is only visible if someone
 * looks at the request URL, which is why it survived in production.
 *
 * TWO ANSWERS, ONE RULE
 * Save time REPORTS it, so the person editing the field learns what is wrong and
 * fixes it for good. The read path REPAIRS it, because a config saved before
 * this rule existed never meets it again — nothing re-validates stored state, so
 * "we reported it" reaches nobody. Two production slots have been 404ing on
 * every review since before the guard was written, and the guard already knows
 * the exact answer for them; it was simply never asked.
 *
 * This file used to refuse to rewrite, with a reason worth keeping in view: a
 * base URL is the one field where guessing on the user's behalf could send their
 * API key somewhere they did not intend. That objection is right in general and
 * does not apply to THIS transformation — it only removes a suffix of the path
 * and never touches the origin, so the credential goes to exactly the host it
 * was already going to. Nor is there a config it could break: the SDK appends
 * the endpoint regardless, so an upstream that genuinely lived at the pasted
 * path was already unreachable.
 *
 * A dependency-free leaf (no NestJS, no registry) so the save path, the read
 * path, the connection probe and the model-listing fetcher can all share the one
 * rule.
 */

/** Endpoint paths a provider SDK appends to the base URL itself. */
const APPENDED_ENDPOINT_PATHS = [
    '/chat/completions',
    '/v1/messages',
    '/messages',
    '/v1/responses',
    '/responses',
    '/completions',
    '/v1/chat/completions',
];

/**
 * The ONE reading of a base URL: which appended endpoint it wrongly carries, and
 * what it should have been. Both public answers below are phrased from this, so
 * the message a user is shown and the URL the runtime dials can never disagree.
 */
function findAppendedEndpoint(
    rawUrl: string,
): { endpoint: string; repaired: string } | undefined {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return undefined; // shape/protocol is the caller's own validation
    }

    const trimmed = parsed.pathname.replace(/\/+$/, '');
    const endpoint = APPENDED_ENDPOINT_PATHS.find((p) =>
        trimmed.toLowerCase().endsWith(p),
    );
    if (!endpoint) {
        return undefined;
    }

    // Origin is preserved by construction — only the endpoint suffix is removed,
    // which is what makes repairing safe here.
    const repaired =
        parsed.origin + trimmed.slice(0, -endpoint.length) || parsed.origin;
    return { endpoint, repaired };
}

/**
 * Returns a human-actionable problem with a user-supplied base URL, or
 * `undefined` when it looks fine. Only reports problems that make the endpoint
 * UNUSABLE — it deliberately says nothing about a missing `/v1`, because plenty
 * of real upstreams (api.deepseek.com among them) serve both forms.
 */
export function describeBaseUrlProblem(rawUrl: string): string | undefined {
    const hit = findAppendedEndpoint(rawUrl);
    if (!hit) return undefined;
    return `Base URL must not include the "${hit.endpoint}" endpoint — the provider appends it. Use "${hit.repaired}" instead.`;
}

/**
 * The stored base URL with a wrongly-appended endpoint removed; the input
 * unchanged when there is nothing to repair (the overwhelming case, and the only
 * one that costs anything on the hot path — a `new URL` parse).
 *
 * For the read path. Save time still REJECTS rather than repairs, so a person
 * typing the field is told; this exists for the configs that were stored before
 * anyone was telling them.
 */
export function repairBaseUrl(rawUrl: string): string;
export function repairBaseUrl(rawUrl: undefined): undefined;
export function repairBaseUrl(rawUrl?: string): string | undefined;
export function repairBaseUrl(rawUrl?: string): string | undefined {
    if (!rawUrl) {
        return rawUrl;
    }
    return findAppendedEndpoint(rawUrl)?.repaired ?? rawUrl;
}

/** Base-URL path suffixes that name a PROTOCOL, not just an endpoint. Reaching
 *  one of these means the upstream is speaking that protocol at that path. */
const PROTOCOL_PATHS: Array<{ suffix: string; protocol: string }> = [
    { suffix: '/anthropic', protocol: 'Anthropic' },
];

/**
 * A base URL that names a DIFFERENT protocol than the provider speaks.
 *
 * The doubled-endpoint rule above catches a URL that is wrong on its own. This
 * catches one that is wrong only in combination: `https://api.minimax.io/anthropic`
 * is a perfectly good base URL — for an Anthropic-protocol provider. Stored under
 * `openai_compatible`, the SDK appends its own path and dials
 * `/anthropic/chat/completions`, which is an OpenAI route under an Anthropic
 * prefix and exists nowhere. One production slot is configured exactly this way.
 *
 * REPORTED, never repaired — unlike the doubled endpoint. There the correct URL
 * is derivable; here it is not. The user either meant `anthropic_compatible` with
 * this URL or `openai_compatible` with the `/v1` one, and those are different
 * requests to a different endpoint. Choosing for them would be guessing at
 * intent, which is a different act from removing a suffix that cannot be
 * intended.
 *
 * Deliberately one-directional: `/v1` is served by both protocols, so an
 * Anthropic-protocol provider pointed at a `/v1` path is not evidence of
 * anything.
 */
export function describeProtocolMismatch(
    provider: string | undefined,
    rawUrl: string | undefined,
): string | undefined {
    if (!provider || !rawUrl) {
        return undefined;
    }
    // Only the OpenAI-protocol ids can be mismatched THIS way. An anthropic
    // brand reaching an `/anthropic` path is simply correct.
    if (provider !== 'openai_compatible') {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return undefined;
    }
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    const hit = PROTOCOL_PATHS.find((p) => path.endsWith(p.suffix));
    if (!hit) {
        return undefined;
    }

    return (
        `This Base URL ends in "${hit.suffix}", which is the ${hit.protocol} protocol endpoint, ` +
        `but the provider is set to OpenAI-compatible. The request would be sent to ` +
        `"${parsed.origin}${path}/chat/completions", which does not exist. ` +
        `Either switch the provider to ${hit.protocol}-compatible, or point the Base URL at this ` +
        `upstream's OpenAI-compatible path instead.`
    );
}
