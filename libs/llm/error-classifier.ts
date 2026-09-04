import {
    AgentContextWindowTooSmallError,
    AgentPromptTooLargeError,
} from './errors';

/**
 * Canonical categories for LLM/provider errors surfaced when calling a model.
 *
 * Why canonical instead of raw provider errors: callers (pipeline stages,
 * UI dashboards, end-of-run messages) need to react to error meaning, not
 * provider-specific strings. The 4 BYOK provider families return errors in
 * different shapes — this enum is the agnostic contract.
 *
 * Terminal categories (AUTH_INVALID / QUOTA_EXCEEDED / MODEL_NOT_FOUND)
 * mean the review cannot succeed without user action — caller may short-
 * circuit remaining stages. TRANSIENT/RATE_LIMIT means "retry-worthy".
 */
export enum LlmErrorCategory {
    AUTH_INVALID = 'AUTH_INVALID',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    RATE_LIMIT = 'RATE_LIMIT',
    MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
    /**
     * The model exists but the account/project isn't entitled to it — most
     * commonly a Google Vertex Anthropic/Gemini model that hasn't been
     * enabled in the project's Model Garden. Distinct from MODEL_NOT_FOUND
     * because the fix is "enable/grant access", not "fix the model name".
     */
    MODEL_ACCESS_DENIED = 'MODEL_ACCESS_DENIED',
    CONTEXT_OVERFLOW = 'CONTEXT_OVERFLOW',
    TRANSIENT = 'TRANSIENT',
    UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedErrorInfo {
    category: LlmErrorCategory;
    provider?: string;
    rawMessage: string;
    httpStatus?: number;
    /** Short, human-readable message safe to surface to the end user. */
    friendlyMessage: string;
}

const CLASSIFICATION_KEY = Symbol('reviewErrorClassification');

/**
 * Attach classification metadata to an Error so downstream catch blocks
 * (e.g. a pipeline stage iterating `result.failures`) can read it without
 * re-classifying. The property is non-enumerable so it doesn't leak into
 * JSON.stringify or span recordings.
 */
export function attachClassification<T extends object>(
    err: T,
    info: ClassifiedErrorInfo,
): T {
    try {
        Object.defineProperty(err, CLASSIFICATION_KEY, {
            value: info,
            enumerable: false,
            writable: false,
            configurable: true,
        });
    } catch {
        // Frozen errors — silently ignore; getClassification will reclassify if needed.
    }
    return err;
}

export function getClassification(
    err: unknown,
): ClassifiedErrorInfo | undefined {
    if (!err || typeof err !== 'object') return undefined;
    return (err as Record<symbol, ClassifiedErrorInfo | undefined>)[
        CLASSIFICATION_KEY
    ];
}

/**
 * Classify a raw provider error into the canonical category.
 *
 * Order matters: HTTP status code first (most reliable across providers),
 * then known error-code/message substrings as fallback.
 *
 * Pure function — does not mutate the input.
 */
export function classifyLLMError(
    err: unknown,
    provider?: string,
): ClassifiedErrorInfo {
    // `err.message` is typed string but at runtime can be null (malformed
    // Error-like objects) — guard so the `rawMessage.toLowerCase()` fallback
    // never throws "Cannot read properties of null (reading 'toLowerCase')".
    const rawMessage =
        (err instanceof Error ? err.message : String(err ?? 'unknown')) ??
        'unknown';
    // Match against the FULL error text, not just `message`. Vercel AI SDK's
    // APICallError sets `message` to a terse "Not Found" while the actionable
    // detail (e.g. Vertex's "your project does not have access to it") lives
    // in the upstream `responseBody`/`data`. Classifying on `message` alone
    // misses it and mislabels access-denied as a plain model-not-found.
    const lower = extractErrorText(err).toLowerCase() || rawMessage.toLowerCase();
    const httpStatus = extractHttpStatus(err);

    let category = matchByHttpStatus(httpStatus, lower);
    if (category === LlmErrorCategory.UNKNOWN) {
        category = matchByMessage(lower);
    }

    return {
        category,
        provider,
        rawMessage,
        httpStatus,
        // Context-overflow gets a richer, actionable message when the
        // underlying error is one of our typed adaptive-fit errors —
        // we have the exact numbers (model, window, measured overhead)
        // and can hand the admin concrete next steps. For raw provider
        // 400s without a typed error, the generic fallback applies.
        friendlyMessage:
            category === LlmErrorCategory.CONTEXT_OVERFLOW
                ? buildContextOverflowMessage(err, provider)
                : buildFriendlyMessage(category, provider),
    };
}

/**
 * True for an aborted / hard-timed-out call. `classifyLLMError` folds AbortError
 * AND `[HARD-TIMEOUT]`/timeout/aborted text into TRANSIENT, but those must NOT be
 * treated as retry-worthy the way a genuine 5xx/network blip is: re-issuing a
 * slow / already-cancelled call just burns the whole timeout budget again (the
 * failure mode is latency, not fidelity). Both the one-shot D-00c re-issue and
 * the runtime model-failover carve these back out of "transient" with this gate.
 * Pure — safe in any catch block.
 */
export function isAbortOrHardTimeout(err: unknown): boolean {
    if (!err) return false;
    if ((err as { name?: string }).name === 'AbortError') return true;
    const text = err instanceof Error ? err.message : String(err ?? '');
    return /\[HARD-TIMEOUT\]|aborted|timed?\s*out|timeout/i.test(text);
}

/**
 * True when the executor already spent ALL of its same-model retries on this
 * error — the AI SDK's `RetryError` with `reason: 'maxRetriesExceeded'`.
 *
 * This is a fact the error CARRIES, not a reading of the vendor's prose, and
 * that is the point. Classifying a 429 as rate-limit-vs-billing by matching
 * English phrases means every vendor that words "you are out of money"
 * differently is a fresh outage: Z.AI writes "Insufficient balance … Please
 * recharge", which said neither quota nor credit, so a spent account was read
 * as a rate limit and the org's configured fallback never ran while its
 * reviews failed.
 *
 * Exhaustion answers the same question without the vocabulary. Exponential
 * backoff is precisely the remedy for a real rate limit; if four spaced
 * attempts did not clear it, the rate-limit reading is already disproven by
 * evidence — it is a closed door, not a queue to wait out.
 *
 * `errorNotRetryable` is deliberately NOT exhaustion: the SDK declined to
 * retry at all, so nothing about the failure has been tested by repetition.
 * Pure — safe in any catch block.
 */
export function retriesWereExhausted(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: string; reason?: string };
    return e.name === 'AI_RetryError' && e.reason === 'maxRetriesExceeded';
}

/**
 * Returns true for categories where retrying without user intervention is
 * pointless: the user must fix billing/auth/config first.
 */
export function isTerminalCategory(category: LlmErrorCategory): boolean {
    return (
        category === LlmErrorCategory.AUTH_INVALID ||
        category === LlmErrorCategory.QUOTA_EXCEEDED ||
        category === LlmErrorCategory.MODEL_NOT_FOUND ||
        category === LlmErrorCategory.MODEL_ACCESS_DENIED
    );
}

/**
 * Log level for an LLM/provider failure. A TERMINAL category (suspended key,
 * out of credit, bad model name, access denied) is a USER config/billing
 * problem, not a Kodus server fault — one root cause fans out to many sub-calls
 * (issue-analysis, suggestion-validation, summary…), each of which used to
 * re-log it at `error`, inflating the error rate for something the user must
 * fix on the provider. Those log at `warn`; a genuine/unknown failure stays
 * `error`. Pure — safe to call in any catch block.
 */
export function llmErrorLogLevel(err: unknown): 'warn' | 'error' {
    return isTerminalCategory(classifyLLMError(err).category) ? 'warn' : 'error';
}

/**
 * Build the searchable text for classification from all the places providers
 * stash detail: `message`, the raw HTTP body (`responseBody`/`data`), and the
 * `cause` chain. The Vercel AI SDK in particular puts the upstream JSON error
 * body in `responseBody` while leaving `message` as a generic status phrase.
 */
function extractErrorText(err: unknown, depth = 0): string {
    if (!err || depth > 3) return '';
    if (typeof err === 'string') return err;
    if (typeof err !== 'object') return String(err);
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.responseBody === 'string') parts.push(e.responseBody);
    if (typeof e.body === 'string') parts.push(e.body);
    if (typeof e.data === 'string') parts.push(e.data);
    else if (e.data && typeof e.data === 'object') {
        try {
            parts.push(JSON.stringify(e.data));
        } catch {
            /* ignore non-serializable */
        }
    }
    if (e.cause && e.cause !== err) {
        parts.push(extractErrorText(e.cause, depth + 1));
    }
    return parts.join(' ');
}

function extractHttpStatus(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
        cause?: { status?: number; statusCode?: number };
    };
    return (
        e.status ??
        e.statusCode ??
        e.response?.status ??
        e.cause?.status ??
        e.cause?.statusCode ??
        undefined
    );
}

function matchByHttpStatus(
    status: number | undefined,
    lowerMessage: string,
): LlmErrorCategory {
    if (status === undefined) return LlmErrorCategory.UNKNOWN;
    if (status === 401 || status === 403) {
        return LlmErrorCategory.AUTH_INVALID;
    }
    if (status === 402) {
        return LlmErrorCategory.QUOTA_EXCEEDED;
    }
    if (status === 429) {
        // 429 is ambiguous: rate limit OR billing quota. Disambiguate via message.
        return looksLikeQuota(lowerMessage)
            ? LlmErrorCategory.QUOTA_EXCEEDED
            : LlmErrorCategory.RATE_LIMIT;
    }
    if (status === 404) {
        // Vertex returns 404 when the project isn't entitled to a publisher
        // model ("...was not found or your project does not have access to
        // it"). That's an enablement problem (Model Garden), not a bad model
        // name — classify it distinctly so the user gets the right fix.
        if (looksLikeModelAccessDenied(lowerMessage)) {
            return LlmErrorCategory.MODEL_ACCESS_DENIED;
        }
        // Most other provider 404s on the inference endpoint are model-not-found.
        return LlmErrorCategory.MODEL_NOT_FOUND;
    }
    if (status >= 500 && status < 600) {
        return LlmErrorCategory.TRANSIENT;
    }
    return LlmErrorCategory.UNKNOWN;
}

/**
 * THE quota vocabulary. There used to be two: this one (quota/credit/billing/
 * payment) decided the ambiguous 429, while `matchByMessage` carried a much
 * richer list. Any wording only the richer list knew about was therefore read
 * as RATE_LIMIT on a 429 -- retry-worthy -- instead of the terminal
 * QUOTA_EXCEEDED, so we retried accounts that could only be fixed by paying.
 *
 * Z.AI/GLM is how it surfaced: "Insufficient balance or no resource package.
 * Please recharge." says neither quota nor credit, and four GLM scopes in
 * production were being retried against a spent balance.
 *
 * One list, both callers.
 */
function looksLikeQuota(lower: string): boolean {
    return (
        lower.includes('quota') ||
        lower.includes('credit') ||
        lower.includes('billing') ||
        lower.includes('payment') ||
        // "balance"/"recharge": Z.AI, GLM and other OpenAI-compatible vendors
        // word a spent prepaid balance this way.
        lower.includes('insufficient balance') ||
        lower.includes('recharge') ||
        // Account-level billing suspension, usually as prose without a
        // billing-shaped status code.
        lower.includes('suspended') ||
        lower.includes('spending limit') ||
        lower.includes('failure to pay') ||
        lower.includes('past invoices') ||
        lower.includes('past due')
    );
}

/**
 * Detects the "model exists but you're not entitled to it" shape. Vertex is
 * the main source: "Publisher Model `...` was not found or your project does
 * not have access to it." (the model must be enabled in Model Garden first).
 */
function looksLikeModelAccessDenied(lower: string): boolean {
    return (
        lower.includes('does not have access') ||
        lower.includes("doesn't have access") ||
        (lower.includes('publisher model') && lower.includes('not found')) ||
        lower.includes('not been allowlisted') ||
        lower.includes('enable the model')
    );
}

function matchByMessage(lower: string): LlmErrorCategory {
    // Same vocabulary the 429 branch uses -- see looksLikeQuota.
    if (looksLikeQuota(lower)) {
        return LlmErrorCategory.QUOTA_EXCEEDED;
    }
    if (
        lower.includes('invalid_api_key') ||
        lower.includes('invalid api key') ||
        lower.includes('incorrect api key') ||
        lower.includes('unauthorized') ||
        lower.includes('authentication failed') ||
        lower.includes('permission_denied')
    ) {
        return LlmErrorCategory.AUTH_INVALID;
    }
    if (
        lower.includes('rate_limit') ||
        lower.includes('rate limit') ||
        lower.includes('too many requests')
    ) {
        return LlmErrorCategory.RATE_LIMIT;
    }
    if (looksLikeModelAccessDenied(lower)) {
        return LlmErrorCategory.MODEL_ACCESS_DENIED;
    }
    if (
        lower.includes('model_not_found') ||
        lower.includes('model not found') ||
        lower.includes('no such model') ||
        lower.includes('does not exist')
    ) {
        return LlmErrorCategory.MODEL_NOT_FOUND;
    }
    if (
        lower.includes('context length') ||
        lower.includes('context_length') ||
        lower.includes('maximum context') ||
        lower.includes('token limit') ||
        lower.includes('too many tokens')
    ) {
        return LlmErrorCategory.CONTEXT_OVERFLOW;
    }
    if (
        lower.includes('econnreset') ||
        lower.includes('etimedout') ||
        lower.includes('socket hang up') ||
        lower.includes('network error') ||
        lower.includes('fetch failed') ||
        lower.includes('timeout') ||
        lower.includes('aborted')
    ) {
        return LlmErrorCategory.TRANSIENT;
    }
    return LlmErrorCategory.UNKNOWN;
}

function buildFriendlyMessage(
    category: LlmErrorCategory,
    provider?: string,
): string {
    const providerLabel = provider ? ` (${provider})` : '';
    switch (category) {
        case LlmErrorCategory.AUTH_INVALID:
            return `The configured API key${providerLabel} appears invalid or lacks permission. Check the key in your settings.`;
        case LlmErrorCategory.QUOTA_EXCEEDED:
            return `The configured API key${providerLabel} is out of credits or has hit its billing limit. Top up the account or adjust the plan.`;
        case LlmErrorCategory.RATE_LIMIT:
            return `Rate limit reached on the provider${providerLabel}. Try again in a few minutes.`;
        case LlmErrorCategory.MODEL_NOT_FOUND:
            return `The configured model is not available on the provider${providerLabel}. Verify the model name in your settings.`;
        case LlmErrorCategory.MODEL_ACCESS_DENIED:
            return (provider || '').toLowerCase().includes('vertex')
                ? `Your Google Cloud project doesn't have access to the configured model on Vertex AI. Enable it in the project's Vertex AI Model Garden (open the model and accept the provider's terms), then comment \`@kody review\` to retry. The model id and region are fine — this is a one-time per-model enablement in Google Cloud.`
                : `Your account doesn't have access to the configured model${providerLabel}. Enable or request access to it on the provider, then retry.`;
        case LlmErrorCategory.CONTEXT_OVERFLOW:
            // Generic fallback only — typed AgentContextWindowTooSmallError /
            // AgentPromptTooLargeError go through buildContextOverflowMessage
            // with the specific numbers and actionable options.
            return `The PR exceeded the maximum context size accepted by the model${providerLabel}.`;
        case LlmErrorCategory.TRANSIENT:
            return `Transient error reaching the provider${providerLabel}. Try again.`;
        default:
            return `Unexpected error while running the code review${providerLabel}.`;
    }
}

/**
 * Mirrors the list shown as preset cards in the BYOK settings page
 * (`apps/web/src/features/ee/byok/_data/curated-models.json`,
 *  `tier: "recommended"` entries). All have ≥32K context, which clears
 * the threshold where the adaptive-fit `compact` profile reliably runs
 * a full-fidelity review.
 *
 * If a model is added/removed/renamed in the curated list, update this
 * note so the error message stays aligned with what the user actually
 * sees in their settings.
 */
const RECOMMENDED_MODELS_FOR_ERROR =
    'Claude Sonnet 4.6, Claude Opus 4.7, Gemini 3.1 Pro, GPT-5.4, Kimi K2.6 Coding, or GLM 5.1';

/**
 * Build an actionable user-facing message for CONTEXT_OVERFLOW errors.
 * When we have the typed error class, we surface the exact numbers and
 * three concrete options (switch model, split PR, raise BYOK limit).
 * For raw provider errors (no typed wrapper), we still surface the
 * recommended-model + split-PR options but omit the BYOK-limit option
 * since we don't have the specific window to compare against.
 *
 * Rendered into the GitHub PR comment via the `withErrors` template's
 * `{{errorMessage}}` placeholder. GitHub-flavored Markdown is honored.
 */
function buildContextOverflowMessage(err: unknown, provider?: string): string {
    const providerLabel = provider ? ` (${provider})` : '';

    if (err instanceof AgentContextWindowTooSmallError) {
        const window = err.contextWindow.toLocaleString('en-US');
        return [
            `This PR is too large for the configured model. \`${err.modelName}\` has a context window of ${window} tokens, but this review needs at least ${err.overheadTokens.toLocaleString('en-US')} tokens of context.`,
            '',
            '**To resolve, choose one:**',
            `- **Switch to a recommended model**: pick one of Kodus's recommended models in your BYOK settings (${RECOMMENDED_MODELS_FOR_ERROR}).`,
            `- **Split the PR into smaller ones**: file count drives prompt overhead.`,
            `- **Raise the model's Max input tokens**: only if your deployed model genuinely supports more than the ${window} tokens our lookup reports (e.g. self-hosted vLLM or Ollama with a custom limit).`,
        ].join('\n');
    }

    if (err instanceof AgentPromptTooLargeError) {
        const window = err.contextWindowTokens.toLocaleString('en-US');
        return [
            `This PR is too large for the configured model. \`${err.modelName}\` has a context window of ${window} tokens, but the assembled prompt would need ${err.estimatedTokens.toLocaleString('en-US')} tokens.`,
            '',
            '**To resolve, choose one:**',
            `- **Switch to a recommended model**: pick one of Kodus's recommended models in your BYOK settings (${RECOMMENDED_MODELS_FOR_ERROR}).`,
            `- **Split the PR into smaller ones**: file count drives prompt overhead.`,
            `- **Raise the model's Max input tokens**: only if your deployed model genuinely supports more than the ${window} tokens our lookup reports (e.g. self-hosted vLLM or Ollama with a custom limit).`,
        ].join('\n');
    }

    // Raw provider error (e.g. a 400 from the upstream with a context-length
    // message) — we don't have the specific window numbers, so we drop the
    // BYOK-limit option (which only makes sense when the user can compare).
    return [
        `This PR exceeded the maximum context size accepted by the configured model${providerLabel}.`,
        '',
        '**To resolve, choose one:**',
        `- **Switch to a recommended model**: pick one of Kodus's recommended models in your BYOK settings (${RECOMMENDED_MODELS_FOR_ERROR}).`,
        `- **Split the PR into smaller ones**: file count drives prompt overhead.`,
    ].join('\n');
}
