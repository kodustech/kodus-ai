/**
 * A reasoning field we added, refused by the upstream that answered.
 *
 * Gateways route one model to several upstreams, and some of them validate the
 * body strictly: OpenCode Go served glm-5.3-flash from one that answered
 * `[unknown_parameter] invalid request body: json: unknown field "thinking"`
 * for two hours and from one that accepted the same body afterwards
 * (2026-09-30). Which upstream answers is the gateway's choice, so no fact about
 * the host or the model can say in advance whether the field is welcome.
 *
 * So the call is asked again without the field the 400 names, once per field
 * and only when we are the ones who put it there. The refusal is remembered for the slot for
 * a few minutes, because the gateway keeps a session on the same upstream and
 * every call would otherwise pay the 400 first; after that the field is tried
 * again.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    extractErrorText,
    extractHttpStatus,
} from '@libs/llm/error-classifier';

export type ReasoningField = 'thinking' | 'reasoning_effort';

/** The body field, and the provider-option keys that render it. */
const OPTION_KEYS: Record<ReasoningField, string[]> = {
    thinking: ['thinking'],
    reasoning_effort: ['reasoningEffort', 'reasoning_effort'],
};

/** One more ask per reasoning field we can add, and no more. */
export const MAX_REFUSAL_RETRIES = Object.keys(OPTION_KEYS).length;

const FIELD = '(thinking|reasoning_effort)';
// Only wordings that say the FIELD is unknown. A 400 that names the field for
// its value ("reasoning_effort 'max' is not supported", or an error envelope's
// `param`) is a configuration the user has to see, so it is not matched.
const REFUSALS = [
    // Go's encoding/json with DisallowUnknownFields (OpenCode Go upstreams).
    new RegExp(`unknown field\\W{1,4}${FIELD}\\b`, 'i'),
    // pydantic extra="forbid".
    new RegExp(
        `extra inputs are not permitted\\W+field\\W{1,4}${FIELD}\\b`,
        'i',
    ),
    // OpenAI's own wording for an argument it does not know.
    new RegExp(
        `unrecognized request argument supplied\\W{1,4}${FIELD}\\b`,
        'i',
    ),
];

/**
 * The body the refused request actually carried, as the AI SDK records it on
 * its `APICallError` (or on the last attempt of a `RetryError`).
 */
function sentBody(
    err: unknown,
    depth = 0,
): Record<string, unknown> | undefined {
    if (!err || typeof err !== 'object' || depth > 3) return undefined;
    const e = err as {
        requestBodyValues?: unknown;
        lastError?: unknown;
        cause?: unknown;
    };
    const body = e.requestBodyValues;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        return body as Record<string, unknown>;
    }
    return sentBody(e.lastError, depth + 1) ?? sentBody(e.cause, depth + 1);
}

/**
 * The reasoning field a 400 refuses, or undefined for any other error.
 *
 * The field must be a top-level key of the body that went out: a refusal that
 * names a field we did not send (OpenAI's Responses API carries the effort as
 * `reasoning.effort`, never `reasoning_effort`) is not about our body, and an
 * error that does not say what was sent gets no second request either.
 */
export function rejectedReasoningField(
    err: unknown,
): ReasoningField | undefined {
    const status = extractHttpStatus(err);
    if (status !== 400 && status !== 422) return undefined;
    const body = sentBody(err);
    if (!body) return undefined;
    const text = extractErrorText(err);
    for (const re of REFUSALS) {
        const m = text.match(re);
        if (!m) continue;
        const field = m[1].toLowerCase() as ReasoningField;
        // Defined, not merely present: the SDK keeps `reasoning_effort:
        // undefined` in the recorded values, and JSON leaves it off the wire.
        return body[field] !== undefined ? field : undefined;
    }
    return undefined;
}

/**
 * The call params without `field`, or undefined when no provider option carries
 * it (the field is not ours, so repeating the call would change nothing).
 */
export function withoutReasoningField<
    P extends { providerOptions?: Record<string, unknown> },
>(params: P, field: ReasoningField): P | undefined {
    const options = params?.providerOptions;
    if (!options) return undefined;
    let removed = false;
    const next: Record<string, unknown> = {};
    for (const [ns, value] of Object.entries(options)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            next[ns] = value;
            continue;
        }
        const kept = { ...(value as Record<string, unknown>) };
        for (const key of OPTION_KEYS[field]) {
            if (key in kept) {
                delete kept[key];
                removed = true;
            }
        }
        next[ns] = kept;
    }
    return removed ? { ...params, providerOptions: next } : undefined;
}

export const REFUSAL_MEMORY_MS = 10 * 60 * 1000;

const refusals = new Map<string, Map<ReasoningField, number>>();

function slotKey(slot: NormalizedModel | undefined, organizationId?: string) {
    if (!slot) return undefined;
    return [
        organizationId ?? '',
        slot.provider,
        slot.baseURL ?? '',
        slot.model,
    ].join('|');
}

export function rememberRefusal(
    slot: NormalizedModel | undefined,
    organizationId: string | undefined,
    field: ReasoningField,
    now = Date.now(),
): void {
    const key = slotKey(slot, organizationId);
    if (!key) return;
    // Refusals are rare, so sweeping here keeps a slot that is never called
    // again from staying in memory for the life of the process.
    for (const [k, byField] of refusals) {
        for (const [f, until] of byField) {
            if (until <= now) byField.delete(f);
        }
        if (byField.size === 0) refusals.delete(k);
    }
    const fields = refusals.get(key) ?? new Map<ReasoningField, number>();
    fields.set(field, now + REFUSAL_MEMORY_MS);
    refusals.set(key, fields);
}

/** The params without every field this slot's upstream refused recently. */
export function withoutRefusedFields<
    P extends { providerOptions?: Record<string, unknown> },
>(
    params: P,
    slot: NormalizedModel | undefined,
    organizationId: string | undefined,
    now = Date.now(),
): P {
    const key = slotKey(slot, organizationId);
    const fields = key ? refusals.get(key) : undefined;
    if (!fields) return params;
    let out = params;
    for (const [field, until] of fields) {
        if (until <= now) {
            fields.delete(field);
            continue;
        }
        out = withoutReasoningField(out, field) ?? out;
    }
    if (fields.size === 0) refusals.delete(key!);
    return out;
}

/** Test seam: forget every remembered refusal. */
export function clearRefusals(): void {
    refusals.clear();
}
