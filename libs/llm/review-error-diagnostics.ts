/**
 * What a failed review is allowed to say about WHY it failed.
 *
 * The pipeline classifies every provider error and then throws almost all of it
 * away: `classifyLLMError` returns the status code, the provider and the
 * provider's own sentence, and the comment builder consumed only
 * `friendlyMessage`. So a reviewer read "Unexpected error while running the code
 * review (open_router)" while the answer — a 429 naming a free-tier limit, a 404
 * naming a routing setting — sat in memory one function call away (#1871).
 *
 * The constraint that shapes this: the text lands in a PUBLIC pull request
 * comment. Provider bodies echo the request often enough that pasting one
 * verbatim is a disclosure bug waiting to happen.
 *
 * The cap is NOT what protects that. Truncating keeps the first 400 characters,
 * which is exactly where an echoed prompt begins — a cap bounds how much leaks,
 * never whether it leaks. What protects it is that only two shapes are ever
 * published: a field the provider itself labelled as a message, and a raw body
 * short and plain enough to read as one sentence ({@link looksLikeProse}).
 * Everything else is dropped, and {@link redactSecrets} runs over what is left.
 */

/** Longest provider sentence that reaches a PR comment. */
const MAX_PROVIDER_MESSAGE = 400;

/**
 * Credential shapes that must never reach a public comment.
 *
 * Deliberately broad: a false redaction costs a reader some context, a missed
 * one publishes a key. `[redacted]` is left behind so the reader can see that
 * something was removed rather than silently reading a truncated sentence.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    // Bearer / Basic authorization headers echoed back in an error body.
    /\b(bearer|basic)\s+[\w\-._~+/]+=*/gi,
    // Provider key prefixes: OpenAI + OpenRouter (sk-, sk-or-v1-), Anthropic
    // (sk-ant-), Google (AIza), AWS access keys (AKIA/ASIA), GitHub (gh[pousr]_).
    /\bsk-[A-Za-z0-9\-_]{8,}/g,
    /\bAIza[A-Za-z0-9\-_]{10,}/g,
    /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    // A key named in a JSON body: {"api_key":"..."} / "authorization": "..."
    /("?(?:api[_-]?key|authorization|access[_-]?token|secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

/**
 * Strip anything credential-shaped from text bound for a public comment.
 *
 * Not a guarantee that the remaining text is safe to publish — it is a floor
 * under the known shapes. The length cap above it is the second half: a body
 * long enough to contain a prompt or a source file gets truncated before any
 * of it is read.
 */
export const redactSecrets = (text: string): string => {
    let out = text;
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, (match, prefix?: string) =>
            // The named-key pattern captures the `"api_key":` part so the field
            // name survives and only the value goes; the others match the whole
            // secret and are replaced outright.
            typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]',
        );
    }
    return out;
};

/** Collapse whitespace and cap, so one runaway body cannot dominate a comment. */
const tidy = (text: string): string => {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > MAX_PROVIDER_MESSAGE
        ? `${collapsed.slice(0, MAX_PROVIDER_MESSAGE).trimEnd()}…`
        : collapsed;
};

/** Depth-limited lookup of a provider's own `message` inside a parsed body. */
const messageIn = (value: unknown, depth = 0): string | undefined => {
    if (!value || depth > 4) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value !== 'object') return undefined;

    const node = value as Record<string, unknown>;
    // Providers converge on `{ error: { message } }`; some nest it, some put the
    // sentence at the top level, and a few use `detail`.
    return (
        messageIn(node.message, depth + 1) ??
        messageIn(node.error, depth + 1) ??
        messageIn(node.detail, depth + 1)
    );
};

const parsed = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        // Not JSON. Nothing is lost by staying quiet: the caller falls through
        // to the prose gate below, which is the only other thing that could be
        // done with the text anyway.
        return undefined;
    }
};

/**
 * Whether a raw body is safe to publish as prose.
 *
 * The structured path above reads ONE field a provider chose to call a message.
 * A raw body has no such promise — it is whatever the endpoint returned, and
 * content filters quote the input they rejected while gateways echo request
 * fields. Truncating that does not help: a cap keeps the FIRST 400 characters,
 * which is exactly where an echoed prompt begins.
 *
 * So a raw body has to earn its way out, and only a short single-sentence answer
 * does: no structural punctuation (a payload, even a truncated one), no code
 * fences or tags, and nothing long enough to be carrying content rather than
 * explaining a failure. Anything else is dropped — the status and the classified
 * message still get reported, which is the floor this exists to raise.
 */
const looksLikeProse = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 200) return false;
    // Structure means payload, not prose.
    if (/[{}[\]<>`]/.test(trimmed)) return false;
    // A quoted key/value pair survives the brace test but is still a payload.
    if (/"\s*:/.test(trimmed)) return false;
    // Several lines is a stack trace or a dump, not a sentence.
    if (trimmed.split(/\r?\n/).length > 2) return false;
    return true;
};

/**
 * The provider's OWN explanation of the failure, ready for a public comment.
 *
 * Preferred over the SDK's `message`, which for a Vercel AI SDK `APICallError`
 * is a terse restatement of the status ("Not Found") while the sentence that
 * names the cause sits in `responseBody`. That gap is why a customer spent a day
 * regenerating a key after being told to "verify the model name", when the body
 * had said the account's allowed-providers list served no upstream for it.
 *
 * Returns `undefined` when the provider said nothing beyond the status — there
 * is no value in printing "Provider said: Not Found" under a message that
 * already explained the 404.
 */
export const extractProviderMessage = (err: unknown): string | undefined => {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as Record<string, unknown>;

    const bodies: unknown[] = [
        e.data,
        typeof e.responseBody === 'string' ? parsed(e.responseBody) : undefined,
        typeof e.body === 'string' ? parsed(e.body) : undefined,
        e.body,
    ];

    for (const body of bodies) {
        const found = messageIn(body);
        if (found) return tidy(redactSecrets(found));
    }

    // No structured body. A plain-text answer still beats the SDK's terse
    // message — but only when it reads as an explanation rather than as a
    // payload the endpoint echoed back. See `looksLikeProse`.
    for (const raw of [e.responseBody, e.body]) {
        if (typeof raw === 'string' && looksLikeProse(raw)) {
            return tidy(redactSecrets(raw));
        }
    }

    return undefined;
};

export type ReviewErrorDiagnostics = {
    /** The classified, user-facing sentence. Always present. */
    friendlyMessage: string;
    provider?: string;
    /** Model id the review actually ran on, from the resolved slot. */
    model?: string;
    httpStatus?: number;
    /** The provider's own sentence, already redacted and capped. */
    providerMessage?: string;
    /** Which agent failed, when the failure was attributed to one. */
    agentName?: string;
};

/**
 * Compose the text a failed review posts on the pull request.
 *
 * The classified sentence stays first and unchanged — it is what a reader acts
 * on. The facts follow on their own line, because the report that prompted this
 * asked for exactly them: which model actually ran, what the provider answered,
 * and with what status. A reader who cannot fix it from the sentence can at
 * least quote the line.
 *
 * Every part is optional and an absent part is omitted rather than printed
 * empty: a review that failed before a provider was resolved has nothing to add,
 * and "Model: undefined" is worse than silence.
 */
export const buildReviewErrorMessage = (
    diagnostics: ReviewErrorDiagnostics,
): string => {
    const { friendlyMessage, provider, model, httpStatus, providerMessage } =
        diagnostics;

    const facts = [
        provider,
        model,
        typeof httpStatus === 'number' ? `HTTP ${httpStatus}` : undefined,
        diagnostics.agentName,
    ].filter((part): part is string => !!part);

    const lines = [friendlyMessage.trim()];
    if (facts.length > 0) lines.push(facts.join(' · '));

    // Only when it adds something. A provider that merely restated the status
    // would otherwise get quoted under a message that already explained it.
    if (providerMessage && !friendlyMessage.includes(providerMessage)) {
        lines.push(`Provider said: ${providerMessage}`);
    }

    return lines.join('\n\n');
};
