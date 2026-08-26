/**
 * Structured-output resilience for the review LLM path (`generateText` +
 * `Output.object`).
 *
 * IMPORTANT SDK reality (ai@7): `repairText` is a `generateObject`/`streamObject`
 * option — `generateText` does NOT thread it, so `Output.object.parseCompleteOutput`
 * simply `JSON.parse`s + `safeValidateTypes` and throws `NoObjectGeneratedError`
 * on failure (`.text` = raw output, `.cause` = JSONParseError | TypeValidationError).
 * The review executor therefore owns the recovery itself, which is also where the
 * observability lives. This module holds the two provider-agnostic primitives it
 * uses:
 *
 *  1. {@link ensureValidatingSchema} — guarantee the wire schema actually VALIDATES
 *     its output. A zod-derived strict-wire schema already carries a validate fn
 *     (`zodToStrictWireSchema`); a raw `jsonSchema()` a caller passed (dedup) does
 *     NOT, so `Output.object` parses but never checks the shape and a model that
 *     renames keys slips through silently (the dedup keep-all class, issue #1786).
 *  2. {@link repairJsonText} / {@link repairAndValidate} — deterministic, model-free
 *     recovery of "almost JSON" (markdown fence, prose wrapper, trailing comma)
 *     before we spend a model re-ask. It never fixes a SHAPE mismatch (valid JSON,
 *     wrong keys) — that needs the model.
 */
import Ajv from 'ajv';
import {
    asSchema,
    jsonSchema,
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
} from 'ai';

/** The AI SDK `ValidationResult` shape (kept local to avoid a type-only import). */
type ValidationResult<T> =
    { success: true; value: T } | { success: false; error: Error };

/**
 * Compile a JSON Schema into an AI-SDK validate function. Fail-soft: an
 * uncompilable schema yields `null` (→ no validation, never a crash). `strict:
 * false` + `allowUnionTypes` so zod's draft-7 output and hand-written review
 * schemas compile instead of being rejected over meta-keywords.
 */
export function ajvValidator<T = unknown>(
    schemaJson: object,
): ((value: unknown) => ValidationResult<T>) | null {
    let validateFn: ReturnType<Ajv['compile']>;
    try {
        const ajv = new Ajv({
            strict: false,
            allErrors: false,
            allowUnionTypes: true,
        });
        validateFn = ajv.compile(schemaJson);
    } catch {
        return null;
    }
    return (value: unknown): ValidationResult<T> => {
        if (validateFn(value)) return { success: true, value: value as T };
        const detail = (validateFn.errors ?? [])
            .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
            .join('; ');
        return {
            success: false,
            error: new TypeValidationError({
                value,
                cause: new Error(`schema validation failed: ${detail}`),
            }),
        };
    };
}

/**
 * Return a wire schema that is guaranteed to validate its output. If the schema
 * already carries a validate fn (the zod strict-wire path) it is returned
 * untouched; a raw `jsonSchema()` gets an ajv validator over its JSON body so a
 * shape mismatch becomes a `TypeValidationError` the executor can recover from.
 * Anything unexpected is returned as-is (fail-soft).
 */
export function ensureValidatingSchema(wire: unknown): unknown {
    if (!wire || typeof wire !== 'object') {
        return wire;
    }
    const s = wire as { jsonSchema?: unknown; validate?: unknown };
    // Already validates (zod strict-wire), or no plain JSON body to compile.
    if (typeof s.validate === 'function') {
        return wire;
    }
    if (!s.jsonSchema || typeof s.jsonSchema !== 'object') {
        return wire;
    }
    const validate = ajvValidator(s.jsonSchema as object);
    if (!validate) {
        return wire;
    }
    return jsonSchema(s.jsonSchema as any, { validate: validate as any });
}

/** Slice out the outermost balanced `{ … }` / `[ … ]`, string-aware so braces
 *  inside string literals don't move the depth. Returns null if none found. */
function sliceBalancedJson(s: string): string | null {
    const start = s.search(/[{[]/);
    if (start < 0) {
        return null;
    }
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') {
            inStr = true;
        } else if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Pull the JSON value out of free-form LLM text: unwrap a ```json fence, drop any
 * prose before/after the outermost balanced `{…}`/`[…]` (string-aware), and strip
 * trailing commas. Returns the JSON substring — even when the input was ALREADY
 * clean JSON (that is the difference from {@link repairJsonText}) — or null when
 * no JSON delimiter is present. This is the ONE text→JSON extractor; the bespoke
 * per-domain copies (finder / safeguard / business-rules) should call it so a
 * fenced or prose-wrapped payload is handled identically everywhere.
 */
export function extractJsonFromText(text: string): string | null {
    if (typeof text !== 'string' || text.trim() === '') {
        return null;
    }
    let s = text.trim();

    // 1. Unwrap a markdown code fence.
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) s = fence[1].trim();

    // 2. Drop any prose before/after the outermost balanced JSON value.
    const sliced = sliceBalancedJson(s);
    if (sliced) s = sliced;

    // 3. Remove trailing commas before a closing } or ].
    s = s.replace(/,(\s*[}\]])/g, '$1');

    // Only report success when an actual JSON delimiter survived — otherwise the
    // text held no JSON to extract.
    return /^[{[]/.test(s) ? s : null;
}

/**
 * Deterministic, model-free repair of "almost JSON": a ```json fence, prose
 * around the object, or a trailing comma. Returns the cleaned string ONLY when
 * it (a) differs from the input and (b) parses — otherwise null, so the caller
 * keeps the original error and escalates to a model re-ask. Never fixes a SHAPE
 * mismatch (valid JSON, wrong keys); that is not string surgery. Built on
 * {@link extractJsonFromText} — same extraction, plus the repair-only guards.
 */
export function repairJsonText(text: string): string | null {
    const candidate = extractJsonFromText(text);
    // Unchanged → the SDK already failed on this exact text (nothing repaired).
    if (candidate == null || candidate === text) {
        return null;
    }
    try {
        JSON.parse(candidate);
    } catch {
        return null; // still not JSON → give up
    }
    return candidate;
}

/**
 * Extract the JSON out of `rawText` (clean, fenced, or prose-wrapped), then
 * validate it against `wire` (the same schema `Output.object` used). Returns the
 * parsed+validated value, or undefined when no JSON is present, it doesn't parse,
 * or it fails the shape (→ caller escalates to a model re-ask). Reuses the wire
 * schema's own validate fn so the object is held to the exact contract.
 *
 * Uses {@link extractJsonFromText}, NOT {@link repairJsonText}: this is a PRIMARY
 * parser (the reroute-json path hands it the model's raw output), so ALREADY-clean
 * JSON is the success case — an always-thinking model that returns pristine
 * `{"…":…}` with no fence/whitespace must validate. `repairJsonText` nulls
 * unchanged input by design (its "nothing to repair" signal for the salvage-after-
 * SDK-failure path), which would reject exactly that clean output.
 */
export async function repairAndValidate<T = unknown>(
    wire: unknown,
    rawText: string,
): Promise<T | undefined> {
    const candidate = extractJsonFromText(rawText);
    if (candidate == null) {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(candidate);
    } catch {
        return undefined;
    }
    const schema = asSchema(wire as any);
    if (typeof schema.validate !== 'function') {
        return value as T;
    }
    const r = await schema.validate(value);
    return r.success ? (r.value as T) : undefined;
}

/**
 * Read the object a `generateText({ output: Output.object })` result produced.
 * ai@7 exposes it as `output`; ai@6 as `experimental_output` — read both so a
 * mixed-version result never silently returns undefined. Single-sourced so every
 * structured entry point (one-shot review + tool-call repair) extracts the same
 * way.
 */
export function readOutput<T = unknown>(result: unknown): T {
    const r = result as { experimental_output?: unknown; output?: unknown };
    return (r?.experimental_output ?? r?.output) as T;
}

/**
 * Deterministically salvage a failed `generateText + Output.object` call. Given
 * the error the SDK threw, returns a repaired+validated value ONLY when it was a
 * JSON PARSE error (fenced / prose-wrapped / trailing-comma) that deterministic
 * repair can fix against `wire`; otherwise undefined (a shape mismatch or any
 * other error is not string-repairable → the caller escalates or gives up). The
 * ONE recovery entry both structured paths share, so the salvage rule lives in a
 * single place.
 */
export async function salvageStructuredError<T = unknown>(
    err: unknown,
    wire: unknown,
): Promise<T | undefined> {
    if (!NoObjectGeneratedError.isInstance(err)) {
        return undefined;
    }
    const { cause, text } = err as { cause?: unknown; text?: unknown };
    if (!JSONParseError.isInstance(cause) || typeof text !== 'string') {
        return undefined;
    }
    return repairAndValidate<T>(wire, text);
}
