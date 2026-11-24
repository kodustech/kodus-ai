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
import { isDeepStrictEqual } from 'node:util';
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

/**
 * The end of every container opened after `start`, from ONE string-aware pass
 * read the way {@link balancedSpanEnd} reads it from `start`: an opener outside
 * a string in that pass gets its end (or -1, never closed) in `ends`. Two
 * openers outside a string see the same strings after them, so the pass
 * answers for all of them at once; one that sat inside a string here gets its
 * own pass when asked. Returns the chars scanned.
 */
function resolveSpansFrom(
    s: string,
    start: number,
    ends: Map<number, number>,
): number {
    const curly: number[] = [];
    const square: number[] = [];
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
        if (ch === '"') inStr = true;
        else if (ch === '{') curly.push(i);
        else if (ch === '[') square.push(i);
        else if (ch === '}') {
            const open = curly.pop();
            if (open !== undefined && !ends.has(open)) ends.set(open, i + 1);
        } else if (ch === ']') {
            const open = square.pop();
            if (open !== undefined && !ends.has(open)) ends.set(open, i + 1);
        }
    }
    for (const open of [...curly, ...square]) {
        if (!ends.has(open)) ends.set(open, -1);
    }
    return s.length - start;
}

/** End (exclusive) of the balanced span opened at `s[start]`, which must be
 *  `{` or `[`, or -1 when it never closes. Same string-aware rule as
 *  {@link sliceBalancedJson}, without copying the text after `start`. */
function balancedSpanEnd(s: string, start: number): number {
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
            if (depth === 0) return i + 1;
        }
    }
    return -1;
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
 * The text with the reasoning blocks written ahead of the answer removed, or
 * null when the text opens a block that never closes (no answer at all).
 */
export function stripReasoningBlocks(text: string): string | null {
    const s = text.trim();
    // Skip reasoning written into the answer. Some models (MiniMax-M3 in
    // production) put <think>…</think> before the JSON, and the reasoning
    // quotes code, so the first balanced {…} would be a quote, not the
    // answer.
    //
    // Only a block that opens BEFORE the JSON starts is reasoning: past that
    // point a <think> or </think> is text inside the answer (a finding about a
    // prompt file quotes both), and each block ends at its FIRST closing tag so
    // an answer that quotes the tag, or is followed by another block, survives.
    // One left-to-right pass, so the cost grows with the length of the text and
    // not with its length times the number of blocks.
    // `<thinking>` is the same block under the other name models use.
    let kept = '';
    let pos = 0;
    const openTag = /<(think|thinking)>/g;
    for (;;) {
        openTag.lastIndex = pos;
        const m = openTag.exec(s);
        if (!m) break;
        const open = m.index;
        const gap = s.slice(pos, open);
        if (/[{[]/.test(gap)) break;
        const closeTag = `</${m[1]}>`;
        const close = s.indexOf(closeTag, open);
        if (close < 0) {
            // A block that never closes and is the first thing in the response
            // carries no answer at all. Anywhere else, including right after a
            // block that did close, the caller may still find one.
            if (pos === 0 && !gap.trim()) return null;
            break;
        }
        kept += gap;
        pos = close + closeTag.length;
    }
    return (kept + s.slice(pos)).trim();
}

/**
 * The first markdown code fence: the first ``` that a later ``` closes, with
 * what lies between them (`inner`, tag included). A linear scan: the regex
 * forms (`/```(?:json)?\s*([\s\S]*?)```/`) backtrack over a run of whitespace
 * after an unclosed fence once per character, quadratic in model-generated
 * text.
 *
 * The closing marker is found by tracking JSON string literals: when a fenced
 * payload is JSON whose description quotes a code fence (a finding about a
 * README, or a summary of a patch), the inner ``` cannot close it, or the
 * caller validates a truncated object (#2687).
 */
function firstFence(
    text: string,
): { start: number; end: number; inner: string } | null {
    const start = text.indexOf('```');
    if (start < 0) return null;
    const body = start + 3;
    let inString = false;
    let escaped = false;
    for (let i = body; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (text.startsWith('```', i)) {
            return { start, end: i + 3, inner: text.slice(body, i) };
        }
    }
    return null;
}

/** A fence's body as the `(?:json)?\s*` prefix leaves it. */
function fenceBody(inner: string): string {
    return inner.replace(/^(?:json)?/i, '').trimStart();
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
    const stripped = stripReasoningBlocks(text);
    if (stripped === null) return null;
    let s = stripped;

    // 1. Unwrap a markdown code fence.
    const fence = firstFence(s);
    const fenced = fence ? fenceBody(fence.inner) : '';
    if (fenced) s = fenced.trim();

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
 * A match `accept` rejects (the prompt's own example, restated after the
 * answer) is skipped, so the answer before it still wins.
 */
export function extractLastJsonObjectWith(
    text: string,
    keys: readonly string[],
    accept: (obj: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | null {
    if (typeof text !== 'string' || text.trim() === '' || keys.length === 0) {
        return null;
    }
    return scanLastJson(text, keys, accept, false) as Record<
        string,
        unknown
    > | null;
}

/**
 * The answer at the end of a reply that may carry reasoning ahead of it: the
 * reasoning blocks are removed first ({@link stripReasoningBlocks}; a block
 * that never closes means no answer, null), then the LAST balanced value that
 * is either an object carrying one of `keys` or a bare array (empty, or of
 * objects) is returned. For a reply whose answer is a list: a draft the
 * reasoning quoted never wins over the final `[]`.
 */
export function extractLastJsonAnswer(
    text: string,
    keys: readonly string[],
): Record<string, unknown> | unknown[] | null {
    if (typeof text !== 'string' || text.trim() === '' || keys.length === 0) {
        return null;
    }
    const stripped = stripReasoningBlocks(text);
    if (stripped === null) return null;
    return scanLastJson(stripped, keys, () => true, true);
}

function scanLastJson(
    text: string,
    keys: readonly string[],
    accept: (obj: Record<string, unknown>) => boolean,
    arrays: boolean,
): Record<string, unknown> | unknown[] | null {
    const wanted = new Set(keys.map(normalizeKeyName));
    let found: Record<string, unknown> | unknown[] | null = null;
    // End of the last JSON object passed over without a wanted key: an array
    // inside it (a provider envelope's `choices`) is that object's data, not
    // the answer, while an object carrying a key inside it still is.
    let insideUntil = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== '{' && !(arrays && ch === '[')) continue;
        const slice = sliceBalancedJson(text.slice(i));
        // Unbalanced from HERE says nothing about a later `{` — keep scanning.
        if (!slice) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(slice.replace(/,(\s*[}\]])/g, '$1'));
        } catch {
            continue; // prose/code, not JSON — keep scanning (incl. nested).
        }
        if (Array.isArray(parsed)) {
            // A list answer: top level, and empty or every entry an object.
            if (
                i < insideUntil ||
                !parsed.every(
                    (e) => !!e && typeof e === 'object' && !Array.isArray(e),
                )
            ) {
                continue;
            }
            found = parsed;
            i += slice.length - 1;
            continue;
        }
        if (!parsed || typeof parsed !== 'object') {
            continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (!Object.keys(obj).some((k) => wanted.has(normalizeKeyName(k)))) {
            insideUntil = Math.max(insideUntil, i + slice.length);
            continue; // maybe a wrapper — let the scan reach the inner object.
        }
        if (accept(obj)) found = obj;
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
/** Chars the fallback walk may scan in total: openers that start no parseable
 *  container each rescan the text after them, and a balanced span that is not
 *  JSON also pays a regex and a parse. The costliest of 3,725 recorded model
 *  replies in evals/ scans ~0.85M, so 5M leaves 6x room and caps the worst
 *  shape at well under a tenth of a second. */
const FALLBACK_SCAN_BUDGET = 5_000_000;

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

/** Parse a JSON slice, retrying once with legalised string literals (#2259):
 *  code quoted in a payload often carries invalid escapes (regex `\d`, Swift
 *  `\(title)`), so the strict parse fails on an otherwise-complete object. */
function parseLenient(slice: string): unknown | undefined {
    try {
        return JSON.parse(slice);
    } catch {
        const escaped = escapeStringLiterals(slice);
        if (escaped === slice) {
            return undefined;
        }
        const retried = tryParse(escaped);
        return retried.ok ? retried.value : undefined;
    }
}

/** The offset an oversized scan starts at so no top-level span is cut in
 *  half: `o` (text.length - SALVAGE_MAX_CHARS) when o falls BETWEEN
 *  top-level spans; otherwise the first position at/after o where the span
 *  o cuts into has closed. One linear string/escape-aware depth pass over
 *  the text — O(N) time, O(1) space, no per-char regex or allocations; a
 *  `{` inside a string literal never counts. Depth at the cut is only
 *  knowable from index 0, so the pass cannot start later; an early span
 *  that never closes extends the same single pass to the text's end (the
 *  window is then empty and nothing is recovered). The expensive part —
 *  sliceBalancedJson and a parse per delimiter — stays capped at
 *  SALVAGE_MAX_CHARS by the caller. A raw cut would sever a container's
 *  opener and promote its nested spans to candidates — a payload fragment
 *  shipped as the answer. */
function windowStartAfterCutSpans(text: string): number {
    const o = text.length - SALVAGE_MAX_CHARS;
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        if (i >= o && depth === 0 && !inStr) {
            return i;
        }
        const ch = text[i];
        if (inStr) {
            if (ch === '\\') {
                i++;
            } else if (ch === '"') {
                inStr = false;
            }
        } else if (ch === '"') {
            inStr = true;
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            if (depth > 0) {
                depth--;
            }
        }
    }
    return text.length;
}

/** The end offset of the PRIMARY candidate's span in `text` (already
 *  reasoning-stripped), mirroring {@link extractJsonFromText}'s selection —
 *  steps 1 and 2 only, PRE-normalisation: trailing-comma stripping and
 *  escape legalisation never move span boundaries, so the span end is
 *  normalization-independent. An indexOf of the NORMALISED candidate is not
 *  (`{,}` normalises to `{}`, whose first occurrence can sit INSIDE the real
 *  answer and exclude it — the 410b3f931 floor bug). Null when no span can
 *  be established (no fence, no balanced slice from the first delimiter) —
 *  the conservative no-floor. */
function primarySpanEnd(text: string): number | null {
    const fence = firstFence(text);
    if (fence && fenceBody(fence.inner)) {
        return fence.end;
    }
    const start = text.search(/[{[]/);
    if (start < 0) {
        return null;
    }
    const slice = sliceBalancedJson(text.slice(start));
    return slice ? start + slice.length : null;
}

/**
 * The FIRST top-level balanced JSON object that parses, starts AFTER the
 * primary candidate's span, and (when the wire schema carries a validate fn)
 * clears it. {@link extractJsonFromText} takes the FIRST fence / outermost
 * value, which is the wrong end of the text when the model QUOTES code or an
 * example object before its real answer (#2255): the quote is what it returns
 * and the answer behind it is lost. The walk goes FORWARD from the primary
 * candidate — deliberately NOT end-favoring like {@link scanLastJson}:
 * review 5939864639 ruled that text AFTER the real answer (a restated
 * example, or the "Empty would be {…}" sentence our own prompts invite,
 * kody-rules-agent.provider.ts) must not win over it — walking from the end
 * shipped an EMPTY review where real findings existed. Only TOP-LEVEL
 * objects compete: a PARSEABLE container is atomic — an object competes as a
 * whole and its nested children or array members never stand in for the
 * answer (those stay undefined, exactly as before this fallback existed) —
 * while a balanced span that is NOT JSON (quoted code, prose with an
 * unmatched brace) is scanned within, since the answer can sit inside it.
 * The one sanctioned nesting is the wrapper envelope: a top-level object
 * that fails validation is retried through its ENVELOPE_WRAPPER_KEYS child,
 * mirroring the rule {@link normalizeEnvelope} applies. Each candidate takes
 * the same escape-legalising retry as the primary path (#2259); without a
 * validate fn (raw jsonSchema, no validator) parse success accepts, matching
 * the primary path. An oversized text (> SALVAGE_MAX_CHARS) walks only its
 * last SALVAGE_MAX_CHARS chars, from an enclosure-aware cut that never
 * starts inside a top-level span (one linear string-aware pass over the
 * full input places it; a severed container cannot promote its nested
 * spans) — the per-delimiter character work stays bounded at the #2112
 * limit while the forward walk keeps the #2255 answer, which trails the
 * quote, inside the window. The accepted residual, flipped with the rule
 * (review 5939864639): a schema-valid example quoted after the primary but
 * BEFORE the answer wins over that answer — schema alone cannot tell them
 * apart; judged cheaper than the silent empty-review loss end-favoring
 * caused.
 */
async function firstValidatingObjectAfter<T = unknown>(
    text: string,
    validate:
        | ((
              value: unknown,
          ) =>
              | ValidationResult<unknown>
              | PromiseLike<ValidationResult<unknown>>)
        | null,
    /** Candidates must END past the primary's span end, in the coordinates
     *  of `text` as passed in (the window mapping below adjusts it): one
     *  that starts after the span, or one that encloses it (the first fence
     *  sat inside the answer's own string value). Null when the text has no
     *  first fence and no balanced span — everything competes. */
    floor: number | null,
    /** The first fence quoted code (no primary candidate came out of it, or
     *  what came out did not validate): a valid object before it makes the
     *  one after it ambiguous, see the walk below. */
    before = false,
    /** No re-ask follows this attempt: an answer before the quote is taken
     *  when it is the only valid object (see the walk below). */
    lastChance = false,
): Promise<T | undefined> {
    // Same #2112 bound as salvageJsonText for the EXPENSIVE part: the
    // candidate walk (sliceBalancedJson + a parse per delimiter) scans at
    // most the last SALVAGE_MAX_CHARS chars, and the forward walk keeps the
    // #2255 answer — which trails the quote — inside it. The cut itself is
    // enclosure-aware — one linear, allocation-free, string/escape-aware
    // pass over the whole input (O(N) time, O(1) space) places it so a
    // severed container cannot promote its nested spans to candidates. The
    // floor maps with the cut: a primary that ended before the window
    // constrains nothing.
    if (text.length > SALVAGE_MAX_CHARS) {
        const windowStart = windowStartAfterCutSpans(text);
        text = text.slice(windowStart);
        floor = floor === null ? null : Math.max(0, floor - windowStart);
    }
    const candidates: { value: unknown; end: number }[] = [];
    // Every opener that starts no parseable container rescans the text after
    // it, so the window alone does not bound the walk: `{` × 1M is ~10^12
    // steps. Past FALLBACK_SCAN_BUDGET chars scanned the walk stops and judges
    // only the candidates it already has.
    // A pass resolves the end of every opener it reads outside a string
    // (resolveSpansFrom), so an unclosed opener no longer charges the rest of
    // the text once per opener: prose quoting `function f(req) {` twenty times
    // before a long answer costs one pass, not twenty.
    let scanned = 0;
    const ends = new Map<number, number>();
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== '{' && ch !== '[') continue;
        if (!ends.has(i)) scanned += resolveSpansFrom(text, i, ends);
        const end = ends.get(i)!;
        if (scanned > FALLBACK_SCAN_BUDGET) {
            // Stop scanning, keep what was found: candidates come in order and
            // the first valid one wins, so a later one could not have beaten
            // it; none found → re-ask, as before.
            break;
        }
        // Unbalanced from HERE says nothing about a later `{` — keep scanning.
        if (end < 0) continue;
        const slice = text.slice(i, end);
        // String-aware (tryParseLenient's rule): a comma inside a literal
        // (`f(a, }` in improvedCode) is payload content and stays; only
        // commas OUTSIDE string literals are stripped. The string
        // alternative swallows the whole literal, so its commas are never
        // visited — a bare comma pattern reintroduces the corruption.
        const parsed = parseLenient(
            slice.replace(/("(?:[^"\\]|\\[\s\S])*")|,(\s*[}\]])/g, '$1$2'),
        );
        // A PARSEABLE container is atomic: an object competes as a whole and
        // its children — nested or array members — never stand in for the
        // answer.
        if (parsed !== undefined) {
            if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            ) {
                candidates.push({ value: parsed, end: i + slice.length });
            }
            i += slice.length - 1;
            continue;
        }
        // Not JSON — a quoted code span or prose. The answer can sit inside
        // it (an unmatched brace before the answer, its closer after), so
        // keep scanning within instead of skipping the span whole.
    }
    const accept = async (
        value: unknown,
    ): Promise<{ value: unknown } | undefined> => {
        if (!validate) {
            return { value };
        }
        const r = await validate(value);
        if (r.success) {
            return { value: r.value };
        }
        // The envelope models wrap around the payload (normalizeEnvelope's
        // keys): retry the wrapper's child before giving up on this candidate.
        for (const key of ENVELOPE_WRAPPER_KEYS) {
            const child = (value as Record<string, unknown>)[key];
            if (!child || typeof child !== 'object' || Array.isArray(child)) {
                continue;
            }
            const rc = await validate(child);
            if (rc.success) {
                return { value: rc.value };
            }
        }
        return undefined;
    };
    const firstAccepted = async (
        list: { value: unknown }[],
    ): Promise<{ value: unknown } | undefined> => {
        for (const { value } of list) {
            const hit = await accept(value);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    };
    // Before or inside the primary's span vs past it. An object that starts
    // before the span but runs past it ENCLOSES it — the first fence sat
    // inside the answer's own string value — so it counts as past.
    const after = candidates.filter((c) => floor === null || c.end > floor);
    const fromAfter = await firstAccepted(after);
    if (!before) {
        // A primary JSON candidate failed: the fallback only takes objects
        // that come AFTER it (review 5939864639).
        return fromAfter?.value as T | undefined;
    }
    // The first fence quoted code, so it is no answer, and the object before
    // it is as plausible as the one after: `{answer} ```ts…``` Empty would
    // be {…}` and `If nothing is wrong I would return {…} ```ts…```
    // {answer}` differ only in order. A schema-valid object on BOTH sides is
    // ambiguous → re-ask, never a guess that can ship an empty review. An
    // object before the quote never stands alone either: a reply cut off
    // after the quote leaves only the prose example.
    const fromBefore = await firstAccepted(
        candidates.filter((c) => floor !== null && c.end <= floor),
    );
    if (!fromAfter) {
        // Only an object before the quote. With a re-ask left it is not
        // taken: a reply cut off after the quote leaves only the prose
        // example. With none left (the caller says so, and only for a reply
        // that ended on its own), it is the answer or nothing.
        return lastChance ? (fromBefore?.value as T | undefined) : undefined;
    }
    if (!fromBefore) return fromAfter.value as T;
    // The same object on both sides (the answer restated after the quote) is
    // no ambiguity.
    return isDeepStrictEqual(fromBefore.value, fromAfter.value)
        ? (fromAfter.value as T)
        : undefined;
}

/**
 * Extract the JSON out of `rawText` (clean, fenced, or prose-wrapped), then
 * validate it against `wire` (the same schema `Output.object` used). Returns the
 * parsed+validated value, or undefined when no JSON is present, nothing parses,
 * or nothing validates (→ caller escalates to a model re-ask). Reuses the wire
 * schema's own validate fn so the object is held to the exact contract.
 *
 * Uses {@link extractJsonFromText}, NOT {@link repairJsonText}: this is a PRIMARY
 * parser (the reroute-json path hands it the model's raw output), so ALREADY-clean
 * JSON is the success case — an always-thinking model that returns pristine
 * `{"…":…}` with no fence/whitespace must validate. `repairJsonText` nulls
 * unchanged input by design (its "nothing to repair" signal for the salvage-after-
 * SDK-failure path), which would reject exactly that clean output.
 *
 * When the primary candidate is absent — the first fence quoted bracketless
 * code, so nothing JSON-shaped surfaced — or it does not parse or validate (the
 * model quoted a code block or an example object AHEAD of its real answer,
 * #2255, so the first-fence extractor returned the quote), the FIRST top-level
 * object AFTER the primary candidate that clears the schema wins instead
 * ({@link firstValidatingObjectAfter}, forward per review 5939864639).
 */
export async function repairAndValidate<T = unknown>(
    wire: unknown,
    rawText: string,
    /** No model re-ask follows this attempt (the second request, a tool-call
     *  correction), and the reply ended on its own: an answer the walk would
     *  otherwise re-ask over is taken when it is the only valid object. */
    opts: { lastChance?: boolean } = {},
): Promise<T | undefined> {
    // A reasoning block that opens first and never closes carries no answer at
    // all — no primary candidate, and no fallback either: the reasoning quotes
    // objects, and they are not the answer.
    const stripped = stripReasoningBlocks(rawText);
    if (stripped === null) {
        return undefined;
    }
    const schema = asSchema(wire as any);
    const validate =
        typeof schema.validate === 'function' ? schema.validate : null;
    const candidate = extractJsonFromText(rawText);
    if (candidate != null) {
        const value = parseLenient(candidate);
        if (value !== undefined) {
            if (!validate) {
                return value as T;
            }
            const r = await validate(value);
            if (r.success) {
                return r.value as T;
            }
        }
    }
    // The fallback walks FORWARD from the primary candidate (review
    // 5939864639): only objects that run past its SPAN compete. The span
    // comes from primarySpanEnd — pre-normalisation, because an indexOf of
    // the normalised candidate (`{,}` → `{}`) can land INSIDE the real
    // answer and exclude it — and it is computed only now that the primary
    // has FAILED: the success path, the common case, never pays the span
    // scan. A first fence that quoted bracketless code yields no candidate
    // but is still the span the extractor took, so it splits the walk too:
    // without it a prose example BEFORE the quote (`If nothing is wrong I
    // would return {"violations":[]}`) beat the real findings after it. No
    // fence and no balanced span → no floor.
    // A first fence whose content did not validate is a quote as well, braces
    // or not: code with `{ b() }` in it made a primary candidate that failed,
    // and without this the `Empty would be {…}` after it beat the answer
    // before it.
    const fence = firstFence(stripped);
    // Only a quote of code lets the object before it stand alone. A fence the
    // model tagged as JSON (json, jsonc, json5), or an untagged one whose body
    // opens on a bracket, is its own answer, invalid: taking the object before
    // it would ship the prompt's example instead. Judged on the fence itself,
    // not on a span the extractor slices from inside it: `request.args["id"]`
    // in a ```python quote has a span that parses, and it is still code.
    const fenceTag = fence ? /^[\w+-]*/.exec(fence.inner)![0] : '';
    const fenceIsJson =
        fence !== null &&
        (/^json[c5]?$/i.test(fenceTag) ||
            (fenceTag === '' && /^\s*[{[]/.test(fence.inner)));
    return firstValidatingObjectAfter<T>(
        stripped,
        validate,
        primarySpanEnd(stripped),
        candidate == null || fence !== null,
        opts.lastChance === true && !fenceIsJson,
    );
}

/**
 * A reply that ended on its own: `stop`, a tool call, or a finish the SDK did
 * not name. `length`, `content-filter` and `other` (what the OpenAI-compatible
 * SDK maps an upstream's `max_tokens` to) are not: asking again meets the same
 * limit or refusal, and what was cut off is not a complete answer.
 */
export function endedOnItsOwn(finishReason: unknown): boolean {
    return (
        finishReason === undefined ||
        finishReason === 'stop' ||
        finishReason === 'tool-calls' ||
        finishReason === 'unknown'
    );
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
    /** No model re-ask follows (see repairAndValidate). */
    opts: { lastChance?: boolean } = {},
): Promise<T | undefined> {
    if (!NoObjectGeneratedError.isInstance(err)) {
        return undefined;
    }
    const { cause, text, finishReason } = err as {
        cause?: unknown;
        text?: unknown;
        finishReason?: unknown;
    };
    if (!JSONParseError.isInstance(cause) || typeof text !== 'string') {
        return undefined;
    }
    return repairAndValidate<T>(wire, text, {
        lastChance: opts.lastChance === true && endedOnItsOwn(finishReason),
    });
}
