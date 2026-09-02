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
 * Single greppable marker for every LLM output-shape / parse issue (#1786 class).
 * Defined in `@libs/llm/log-tags` (the one home for all LLM log tags) and
 * re-exported here for the recovery call-sites that already import from this
 * module.
 */
export { LLM_ENVELOPE_TAG } from '@libs/llm/log-tags';

/** Wrapper keys the non-strict models emit around the real payload. Unwrapped
 *  only when the current object does NOT already carry the target key/alias, so a
 *  legit `{ suggestions, meta }` is never descended into. `"0"` covers the
 *  `{"0": D}` numeric-index wrap; `content`/`data`/`result`/… the object wraps. */
const ENVELOPE_WRAPPER_KEYS = [
    'result',
    'data',
    'output',
    'response',
    'json',
    'content',
    'payload',
    '0',
];

/** Case/convention-insensitive key match: `Suggestions`, `query_tasks`,
 *  `code-suggestions` all collapse to the same normal form. */
function normalizeKeyName(k: string): string {
    return k.toLowerCase().replace(/[_\-\s]/g, '');
}

function locateKey(
    obj: Record<string, unknown>,
    key: string,
    aliases: string[],
): string | undefined {
    const wanted = [key, ...aliases];
    // 1. exact.
    for (const w of wanted) {
        if (Object.prototype.hasOwnProperty.call(obj, w)) return w;
    }
    // 2. case/convention-insensitive.
    const wantedNorm = new Set(wanted.map(normalizeKeyName));
    for (const actual of Object.keys(obj)) {
        if (wantedNorm.has(normalizeKeyName(actual))) return actual;
    }
    return undefined;
}

/**
 * Coerce a parsed LLM value into the canonical `{ [key]: … }` shape when a
 * non-strict model wrapped, renamed, bare-arrayed, case-mangled, or stringified
 * it — the SHAPE mismatch layer {@link repairJsonText} explicitly does not touch
 * (valid JSON, wrong container). Pure and conservative: it never invents data,
 * only unwraps known envelope keys (when the target key is absent), lifts a bare
 * array under `key`, aliases a renamed/case-mismatched key, and parses a
 * stringified-JSON payload. Returns the value UNCHANGED when it is already
 * canonical or nothing safe applies — so the caller's existing `.key` read then
 * finds the data instead of silently seeing `undefined` (issue #1786).
 *
 * `key` is the canonical field the caller reads (e.g. `suggestions`, `rules`,
 * `codeSuggestions`); `aliases` the renamed forms a model emits for it.
 *
 * `opts.scalar` — set when `key` holds a SCALAR (e.g. verifier `keep`, compiler
 * `mechanical`), not an array: a bare `[{key:…}]` then descends into its first
 * element instead of being lifted as `{ [key]: [...] }`.
 *
 * `opts.onRecover` — observability hook, called ONCE with a short reason
 * whenever a real off-schema recovery happened (parse / unwrap / lift / alias),
 * so callers can log which model shape #1786 fired on. Not called on a no-op.
 */
export function normalizeEnvelope(
    value: unknown,
    key: string,
    aliases: string[] = [],
    opts: { scalar?: boolean; onRecover?: (reason: string) => void } = {},
): unknown {
    let v: unknown = value;
    let reason = '';

    // 0. stringified JSON — parse it, then normalize the result.
    if (typeof v === 'string') {
        const candidate = extractJsonFromText(v);
        if (candidate != null) {
            try {
                v = JSON.parse(candidate);
                reason = 'parsed-stringified-json';
            } catch {
                return value; // not JSON after all → hand back the original.
            }
        } else {
            return value;
        }
    }

    // 1. unwrap known wrappers ({result:D}, {result:{result:D}}, {content:D},
    //    {"0":D}) — but only while the target key/alias is NOT already present,
    //    so `{ suggestions, meta }` is left intact.
    for (let depth = 0; depth < 5; depth++) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) break;
        const obj = v as Record<string, unknown>;
        if (locateKey(obj, key, aliases)) break; // already canonical-ish.
        // Only descend into a KNOWN, named wrapper key — never guess by "the
        // object has a single key", which would falsely unwrap real payloads
        // (e.g. a provider envelope `{choices:[{message:{content}}]}` is NOT the
        // target array and must not be lifted as one).
        const wrapKey = Object.keys(obj).find((k) =>
            ENVELOPE_WRAPPER_KEYS.includes(k),
        );
        if (
            wrapKey === undefined ||
            obj[wrapKey] == null ||
            typeof obj[wrapKey] !== 'object'
        ) {
            break;
        }
        v = obj[wrapKey];
        reason = `unwrapped-${wrapKey}`;
    }

    // 2. bare array. For an array-valued target: lift a NON-EMPTY array under
    //    `key` (an empty one carries no data — return the original so the
    //    caller's empty/unusable outcome stands). For a SCALAR target: a bare
    //    array is not the payload — descend into its first object element so
    //    step 3 can locate the scalar key there.
    if (Array.isArray(v)) {
        if (opts.scalar) {
            if (v.length > 0 && v[0] && typeof v[0] === 'object') {
                v = v[0];
                reason = 'unwrapped-array-element';
            } else {
                return value;
            }
        } else if (v.length > 0) {
            opts.onRecover?.(reason || 'lifted-bare-array');
            return { [key]: v };
        } else {
            return value;
        }
    }

    // 3. object with the payload under a renamed / case-mismatched key.
    if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        const found = locateKey(obj, key, aliases);
        if (found && found !== key) {
            const { [found]: hit, ...rest } = obj;
            opts.onRecover?.(`aliased-${found}`);
            return { ...rest, [key]: hit };
        }
    }

    if (reason && v !== value) {
        opts.onRecover?.(reason);
    }
    return v;
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
