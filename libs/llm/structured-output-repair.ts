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
        if (validateFn(value)) {
            return { success: true, value: value as T };
        }
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

    // 0. Skip reasoning written into the answer. Some models (MiniMax-M3 in
    // production) put <think>…</think> before the JSON, and the reasoning
    // quotes code, so the first balanced {…} below would be a quote, not the
    // answer.
    //
    // Only a block that opens BEFORE the JSON starts is reasoning: past that
    // point a <think> or </think> is text inside the answer (a finding about a
    // prompt file quotes both), and each block ends at its FIRST closing tag so
    // an answer that quotes the tag, or is followed by another block, survives.
    // One left-to-right pass, so the cost grows with the length of the text and
    // not with its length times the number of blocks.
    let kept = '';
    let pos = 0;
    for (;;) {
        const open = s.indexOf('<think>', pos);
        if (open < 0) break;
        const gap = s.slice(pos, open);
        if (/[{[]/.test(gap)) break;
        const close = s.indexOf('</think>', open);
        if (close < 0) {
            // A block that never closes and is the first thing in the response
            // carries no answer at all. Anywhere else, including right after a
            // block that did close, the scan below may still find one.
            if (pos === 0 && !gap.trim()) return null;
            break;
        }
        kept += gap;
        pos = close + '</think>'.length;
    }
    s = (kept + s.slice(pos)).trim();

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
 * Scan free-form LLM text for EVERY balanced `{…}` and return the LAST one that
 * parses AND carries one of `keys` at its top level.
 *
 * {@link extractJsonFromText} takes the FIRST fenced block / outermost value,
 * which is the wrong end of the text when the model quotes code (or an example
 * object) before writing its real answer: it returns the quote and the caller's
 * parse fails. This walks to the end instead, so the answer wins over anything
 * quoted on the way there. Key matching is convention-insensitive
 * (`shouldKeep` ≡ `should_keep`) — the same rule {@link normalizeEnvelope} uses.
 */
export function extractLastJsonObjectWith(
    text: string,
    keys: readonly string[],
): Record<string, unknown> | null {
    if (typeof text !== 'string' || text.trim() === '' || keys.length === 0) {
        return null;
    }
    const wanted = new Set(keys.map(normalizeKeyName));
    let found: Record<string, unknown> | null = null;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') continue;
        const slice = sliceBalancedJson(text.slice(i));
        // Unbalanced from HERE says nothing about a later `{` — keep scanning.
        if (!slice) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1'));
        } catch {
            continue; // prose/code, not JSON — keep scanning (incl. nested).
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (!Object.keys(obj).some((k) => wanted.has(normalizeKeyName(k)))) {
            continue; // maybe a wrapper — let the scan reach the inner object.
        }
        found = obj;
        i += slice.length - 1; // don't re-match objects nested inside the hit.
    }
    return found;
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

/** Above this size a broken payload is not worth a character scan (#2112). */
const SALVAGE_MAX_CHARS = 1_000_000;

/**
 * Make the string literals of almost-JSON legal: raw control characters
 * (a newline inside code) become escapes, `\'` becomes `'`, and any other
 * backslash that does not start a JSON escape is doubled. Text outside string
 * literals is left as is.
 */
function escapeStringLiterals(s: string): string {
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (!inStr) {
            if (ch === '"') inStr = true;
            out += ch;
            continue;
        }
        if (ch === '"') {
            inStr = false;
            out += ch;
        } else if (ch === '\\') {
            const next = s[i + 1];
            if (next === "'") {
                out += "'";
                i++;
            } else if (
                next !== undefined &&
                ('"\\/bfnrt'.includes(next) ||
                    (next === 'u' &&
                        /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))))
            ) {
                out += ch + next;
                i++;
            } else {
                out += '\\\\';
            }
        } else if (ch < ' ') {
            out +=
                ch === '\n'
                    ? '\\n'
                    : ch === '\r'
                      ? '\\r'
                      : ch === '\t'
                        ? '\\t'
                        : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
            out += ch;
        }
    }
    return out;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(s) };
    } catch {
        return { ok: false };
    }
}

/**
 * {@link tryParse}, then once more without the commas that sit before a `}` or
 * `]` outside string literals. A comma inside a string (code such as
 * `f(a, )`) is the value itself and stays.
 */
function tryParseLenient(
    s: string,
): { ok: true; value: unknown } | { ok: false } {
    const exact = tryParse(s);
    if (exact.ok) return exact;
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (ch === '\\') {
                out += ch + (s[i + 1] ?? '');
                i++;
                continue;
            }
            if (ch === '"') inStr = false;
        } else if (ch === '"') {
            inStr = true;
        } else if (ch === ',' && /^\s*[}\]]/.test(s.slice(i + 1))) {
            continue;
        }
        out += ch;
    }
    return out === s ? exact : tryParse(out);
}

/**
 * Model-free salvage of a payload `JSON.parse` rejected (#2112). Non-strict
 * models send findings as JSON text with unescaped characters inside code, a
 * stray `}` after the array, or a break halfway through. Tried in order:
 *
 *  1. escape the string literals ({@link escapeStringLiterals});
 *  2. keep the leading complete value and drop the text after it;
 *  3. keep the complete array items before the break — the array is the text
 *     itself when it starts with `[`, else the one under `"<arrayKey>": [`.
 *
 * Only values that parse whole are kept; a half-written item is never patched.
 * Returns the value and the step that produced it, or undefined.
 */
export function salvageJsonText(
    text: string,
    arrayKey?: string,
): { value: unknown; reason: string } | undefined {
    if (typeof text !== 'string' || text.length > SALVAGE_MAX_CHARS) {
        return undefined;
    }
    const raw = text.trim();
    const s = escapeStringLiterals(raw);

    if (s !== raw) {
        const whole = tryParse(s);
        if (whole.ok) return { value: whole.value, reason: 'salvaged-escaped' };
    }

    const leading = sliceBalancedJson(s);
    if (leading && leading !== s) {
        const head = tryParseLenient(leading);
        if (head.ok) {
            return { value: head.value, reason: 'salvaged-leading-value' };
        }
    }

    let start = -1;
    if (s.startsWith('[')) {
        start = 0;
    } else if (arrayKey) {
        const m = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`).exec(s);
        if (m) start = m.index + m[0].length - 1;
    }
    if (start < 0) return undefined;
    const items: unknown[] = [];
    let i = start + 1;
    while (i < s.length) {
        while (i < s.length && /[\s,]/.test(s[i])) i++;
        if (s[i] !== '{') break;
        const slice = sliceBalancedJson(s.slice(i));
        if (!slice) break;
        const item = tryParseLenient(slice);
        if (!item.ok) break;
        items.push(item.value);
        i += slice.length;
    }
    if (items.length === 0) return undefined;
    return {
        value: start === 0 ? items : { [arrayKey as string]: items },
        reason: 'salvaged-items',
    };
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
        // A single invalid escape inside a string literal - code quoted in a
        // suggestion, such as Swift `\(title)` or a regex `\d` - makes the whole
        // payload unparseable, and the reroute-json caller then loses every
        // finding for that shard (#2259). Legalise the string escapes and retry;
        // a payload broken any other way still fails, so a cut list is never
        // accepted as a whole one.
        const escaped = escapeStringLiterals(candidate);
        if (escaped === candidate) {
            return undefined;
        }
        const retried = tryParse(escaped);
        if (!retried.ok) {
            return undefined;
        }
        value = retried.value;
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
 * The array a string-valued target key holds as JSON text, or undefined when
 * the text is not one. A parsed object that carries the key itself (the model
 * stringified the whole envelope into the field) yields that inner array.
 */
function parseFieldText(
    text: string,
    key: string,
    aliases: string[],
    salvage: boolean,
): { value: unknown[]; reason: string } | undefined {
    const candidate = extractJsonFromText(text);
    const direct = candidate != null ? tryParse(candidate) : null;
    let out: unknown;
    let reason: string;
    if (direct?.ok) {
        out = direct.value;
        reason = 'parsed-field-string';
    } else {
        const salvaged = salvage ? salvageJsonText(text, key) : undefined;
        if (!salvaged) return undefined;
        out = salvaged.value;
        reason = `${salvaged.reason}-field`;
    }
    if (out && typeof out === 'object' && !Array.isArray(out)) {
        const inner = locateKey(out as Record<string, unknown>, key, aliases);
        out = inner ? (out as Record<string, unknown>)[inner] : undefined;
    }
    return Array.isArray(out) ? { value: out, reason } : undefined;
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
 *
 * `opts.liftEmptyArray` — by default a bare EMPTY array is a no-op (it carries
 * no data). Set this for a target where `{ [key]: [] }` is a VALID answer — e.g.
 * the kody-rules shard's `[]` means "no violations", which must become
 * `{violations:[]}` (a clean pass) rather than fail the wire schema, and the
 * finder's `[]` means it found nothing (#2112).
 *
 * `opts.salvage` — when the payload or the target key is JSON text that does
 * not parse, keep what {@link salvageJsonText} can read whole (#2112). Off by
 * default: a caller that treats a broken response as a failure keeps doing so.
 * The reason it reports starts with `salvaged-`, so a caller can tell a cut
 * payload from a whole one.
 */
export function normalizeEnvelope(
    value: unknown,
    key: string,
    aliases: string[] = [],
    opts: {
        scalar?: boolean;
        liftEmptyArray?: boolean;
        salvage?: boolean;
        onRecover?: (reason: string) => void;
    } = {},
): unknown {
    let v: unknown = value;
    let reason = '';

    // 0. stringified JSON — parse it, then normalize the result.
    //    Text JSON.parse rejects goes through the salvage (#2112) when the
    //    caller opts in; everyone else keeps the original.
    if (typeof v === 'string') {
        const candidate = extractJsonFromText(v);
        const parsed = candidate != null ? tryParse(candidate) : null;
        if (parsed?.ok) {
            v = parsed.value;
            reason = 'parsed-stringified-json';
        } else {
            const salvaged = opts.salvage ? salvageJsonText(v, key) : undefined;
            if (!salvaged) return value; // not JSON after all → hand back the original.
            v = salvaged.value;
            reason = salvaged.reason;
        }
    }

    // 1. unwrap known wrappers ({result:D}, {result:{result:D}}, {content:D},
    //    {"0":D}) — but only while the target key/alias is NOT already present,
    //    so `{ suggestions, meta }` is left intact.
    for (let depth = 0; depth < 5; depth++) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            break;
        }
        const obj = v as Record<string, unknown>;
        if (locateKey(obj, key, aliases)) {
            break;
        } // already canonical-ish.
        // A tool call written out as data — `{name, parameters}` or
        // `{name, arguments}`, the arguments possibly as JSON text (#2112).
        const argsKey =
            !opts.scalar && typeof obj.name === 'string'
                ? ['parameters', 'arguments'].find((k) => k in obj)
                : undefined;
        if (argsKey !== undefined) {
            let args = obj[argsKey];
            if (typeof args === 'string') {
                const p = tryParse(args);
                args = p.ok ? p.value : undefined;
            }
            if (!args || typeof args !== 'object') {
                break;
            }
            v = args;
            reason = 'unwrapped-tool-call';
            continue;
        }
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
        } else if (v.length > 0 || opts.liftEmptyArray) {
            // A non-empty array carries data → lift. An empty one lifts only for
            // a schema-envelope caller (liftEmptyArray) where `{key:[]}` is the
            // canonical "nothing found" answer; the finder path leaves `[]` alone.
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
        if (found) {
            let hit = obj[found];
            // The located key holds the payload as JSON text (#2112): parse
            // it, for an array-valued target only.
            const fromText =
                !opts.scalar && typeof hit === 'string'
                    ? parseFieldText(hit, key, aliases, !!opts.salvage)
                    : undefined;
            if (fromText) hit = fromText.value;
            if (found !== key || fromText) {
                const { [found]: _drop, ...rest } = obj;
                opts.onRecover?.(
                    [found !== key && `aliased-${found}`, fromText?.reason]
                        .filter(Boolean)
                        .join('+'),
                );
                return { ...rest, [key]: hit };
            }
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
