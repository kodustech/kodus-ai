/**
 * code-review (domain) — the findings output schema + sanitizer.
 *
 * Relocated from the legacy llm/agent-loop.ts so the decomposed agent path
 * (finder.agent) doesn't reach into the 4.5k-line legacy file for it.
 */
import { z } from 'zod';
import { createLogger } from '@libs/core/log/logger';
import {
    extractJsonFromText,
    normalizeEnvelope,
} from '@libs/llm/structured-output-repair';
import { LLM_ENVELOPE_TAG } from '@libs/llm/log-tags';

const logger = createLogger('FindingsSchema');

/**
 * An optional field that is absent, or holds a value of the wrong type, reads
 * as absent: a finding is never dropped over metadata (#2112). `null` is
 * already removed by {@link prepareItem}.
 */
const lenient = <T extends z.ZodTypeAny>(schema: T) =>
    schema.optional().catch(undefined);

const nonBlank = (s: string) => s.trim() !== '';

/** Schema for structured output */
const suggestionSchema = z.object({
    // Id of an earlier Kody suggestion on this PR that this finding revises,
    // reverses, or exists because of (#2039/#2020) — PreviousDecision Id.
    revisesSuggestionId: lenient(z.string()),
    // The two fields every consumer reads unguarded (verifier.agent.ts,
    // finder.agent.ts): without them there is no finding to keep.
    relevantFile: z.string().refine(nonBlank),
    language: lenient(z.string()),
    // Any string: a label off the list is replaced by `bug` after anchoring
    // (normalizeFinderLabels, #1821), never a reason to drop the finding here.
    label: lenient(z.string()),
    suggestionContent: z.string().refine(nonBlank),
    // A finding without a fix is still a finding: the #1833 gate
    // (agent-review.stage.ts) publishes it as a plain comment.
    existingCode: z
        .string()
        .optional()
        .catch(undefined)
        .transform((v) => v ?? ''),
    improvedCode: z
        .string()
        .optional()
        .catch(undefined)
        .transform((v) => v ?? ''),
    oneSentenceSummary: lenient(z.string()),
    relevantLinesStart: lenient(z.number()),
    relevantLinesEnd: lenient(z.number()),
    severity: lenient(z.enum(['critical', 'high', 'medium', 'low'])), // V2 compat
    // Self-reported, telemetry-only (see review-finding.ts) — the model is
    // prompted for 1-10 but not reliably in-range (prod audit 2026-09-17:
    // ~150/619 [LLM_ENVELOPE] drops were an otherwise-valid suggestion
    // discarded solely for confidence outside [1,10], commonly 0). Do not
    // range-check here: an out-of-range value must not drop a real finding.
    confidence: lenient(z.number()),
    ruleUuid: lenient(z.string()), // Kody Rules: UUID of the violated rule
    // O percurso que produziu ESTE achado, quando `requireFindingReason` esta
    // ligado. Precisa estar aqui: o zod descarta campo desconhecido, entao sem
    // a linha o modelo devolve o campo e o sanitizador o joga fora em silencio
    // — foi o que aconteceu no primeiro run com a flag ligada, 0 de 21
    // candidatos chegaram com reason.
    reason: lenient(z.string()),
    // EXPERIMENTO (#1821, so o eval liga). O nivel de desenvolvedor que
    // reportaria este achado. Precisa estar declarado aqui pelo mesmo motivo
    // que o `reason`: campo que o zod nao conhece e descartado em silencio, e
    // o experimento mediria um campo que nunca chegou.
    //
    // Normalizado porque o modelo responde em varias grafias (junior/Junior/
    // jr, mid/pleno/intermediate, senior/sr, expert/staff/principal). Valor desconhecido limpa o
    // campo em vez de derrubar o achado — a mesma regra do `severity`.
    developerLevel: z.preprocess((v) => {
        const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
        if (/^(jr|junior|j[uú]nior)$/.test(s)) return 'junior';
        if (/^(mid|pleno|intermediate|mid-?level)$/.test(s)) return 'pleno';
        if (/^(sr|senior|s[eê]nior)$/.test(s)) return 'senior';
        if (/^(expert|especialista|staff|principal|architect)$/.test(s)) return 'expert';
        if (/^(qa|quality[ -]?analy[sz](t|er)|tester)$/.test(s)) return 'qa';
        return undefined;
    }, z.enum(['junior', 'pleno', 'senior', 'expert', 'qa']).optional()),
    // Custom agents: 'convention' = the finding applies a team guide, quoted in
    // `source`; the quote is checked on the target branch before verify. An
    // off-schema value reads as absent instead of dropping the finding.
    kind: z.enum(['bug', 'convention']).optional().catch(undefined),
    source: z
        .object({
            file: z.string(),
            section: z.string().optional(),
            quote: z.string(),
        })
        .optional()
        .catch(undefined),
});

const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

export type FindingsOutput = z.infer<typeof _findingsSchema>;

/** A finding whose body is only in `oneSentenceSummary` still names a defect:
 *  use the summary as the content instead of dropping it. */
function withContentFallback(item: unknown): unknown {
    if (!item || typeof item !== 'object') return item;
    const it = item as Record<string, unknown>;
    if (typeof it.suggestionContent === 'string' || typeof it.oneSentenceSummary !== 'string') {
        return item;
    }
    return { ...it, suggestionContent: it.oneSentenceSummary };
}

/**
 * Claude models (measured on Sonnet 5.5, #1821) often send the `suggestions`
 * array of a tool call as a JSON-encoded STRING inside an otherwise valid
 * object. normalizeEnvelope only parses a stringified container, so the field
 * failed validation and every finding in it fell to text parsing and was lost
 * (40 of 90 lens passes in one run). Parse the field when it holds a JSON
 * array; any other string is left for validation to reject as before.
 */
function parseStringifiedSuggestions(value: unknown): unknown {
    const suggestions = (value as { suggestions?: unknown } | null)
        ?.suggestions;
    if (typeof suggestions !== 'string') return value;
    // The raw string first: a suggestion usually carries ``` fences in its own
    // text, and extractJsonFromText unwraps the FIRST fence it sees — an inner
    // code block, not the array (that is what kept 10 of 40 failing after the
    // first fix). The extractor stays as the fallback for prose/fence wrapping.
    for (const candidate of [suggestions.trim(), extractJsonFromText(suggestions)]) {
        if (!candidate) continue;
        try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed)) {
                return { ...(value as object), suggestions: parsed };
            }
        } catch {
            // try the next candidate
        }
    }
    dumpUnparsedSuggestions(suggestions);
    return value;
}

/** Eval-only (RECALL_DEBUG_ENVELOPE_DIR): keep the raw string a model sent when
 *  it could not be parsed, so the shape can be fixed without re-running. */
function dumpUnparsedSuggestions(raw: string): void {
    const dir = process.env.RECALL_DEBUG_ENVELOPE_DIR;
    if (!dir) return;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            `${dir}/suggestions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
            raw,
        );
    } catch {
        // diagnostics must never break a review
    }
}

const KNOWN_ITEM_KEYS = new Set(Object.keys(suggestionSchema.shape));
const NUMERIC_KEYS = ['relevantLinesStart', 'relevantLinesEnd', 'confidence'];
const ENUM_KEYS = ['label', 'severity', 'kind'];

/** Why a finding was dropped, and the shape it had — never its content. */
type ItemDrop = {
    reason: string;
    field?: string;
    type: string;
    length: number;
    keys?: string[];
    unknownKeys?: number;
    hasSummary?: boolean;
    parsesAsObject?: boolean;
};

/** A model-chosen key name, unless it could carry content (a path, text). */
const safeKey = (k: string): string =>
    /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/.test(k) ? k : '<other>';

const jsonType = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

const jsonLength = (v: unknown): number => {
    try {
        return (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).length;
    } catch {
        return 0;
    }
};

/**
 * Bring an item to the shape the schema reads: `null` fields removed, numeric
 * strings to numbers, enum values lowercased. Items that are no finding at all
 * come back as a drop — a non-object, or a MiniMax `{"$text": …}` node (the
 * provider turns an XML tool call into JSON and leaves a field's value as its
 * own array item with the field name lost; it cannot be put back).
 */
function prepareItem(
    item: unknown,
): { value: Record<string, unknown> } | { drop: ItemDrop } {
    const shape = { type: jsonType(item), length: jsonLength(item) };
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        let parsesAsObject = false;
        if (typeof item === 'string') {
            try {
                const p = JSON.parse(item);
                parsesAsObject =
                    !!p && typeof p === 'object' && !Array.isArray(p);
            } catch {
                parsesAsObject = false;
            }
        }
        return { drop: { reason: 'non-object', ...shape, parsesAsObject } };
    }
    const keys = Object.keys(item);
    if (keys.length === 1 && keys[0] === '$text') {
        return { drop: { reason: 'provider-text-node', ...shape } };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item)) {
        if (v === null) continue;
        if (
            NUMERIC_KEYS.includes(k) &&
            typeof v === 'string' &&
            /^\s*-?\d+(\.\d+)?\s*$/.test(v)
        ) {
            out[k] = Number(v);
        } else if (ENUM_KEYS.includes(k) && typeof v === 'string') {
            out[k] = v.trim().toLowerCase();
        } else {
            out[k] = v;
        }
    }
    return { value: out };
}

function describeDrop(
    prepared: Record<string, unknown>,
    item: object,
    issues: readonly { path: PropertyKey[] }[],
): ItemDrop {
    const field = String(issues[0]?.path?.[0] ?? '');
    const v = prepared[field];
    const keys = Object.keys(item);
    const summary = prepared.oneSentenceSummary;
    return {
        reason:
            v === undefined || (typeof v === 'string' && !nonBlank(v))
                ? `missing-${field}`
                : `invalid-${field}`,
        field,
        type: jsonType(item),
        length: jsonLength(item),
        keys: keys.filter((k) => KNOWN_ITEM_KEYS.has(k)),
        unknownKeys: keys.filter((k) => !KNOWN_ITEM_KEYS.has(k)).length,
        hasSummary: typeof summary === 'string' && nonBlank(summary),
    };
}

type FindingsTelemetry = { organizationId?: string; modelId?: string };

/**
 * Validate and sanitize a done-tool result: the FindingsOutput, and the drops
 * that were not findings ({@link ItemDrop}). `result` is null when the payload
 * holds no findings array at all. `silent` skips the logs, for a caller that
 * re-reads an artifact already logged.
 */
export function inspectFindingsResult(
    raw: unknown,
    telemetryMetadata?: FindingsTelemetry,
    opts: { silent?: boolean } = {},
): {
    result: FindingsOutput | null;
    drops: ItemDrop[];
    recoveries: string[];
} {
    if (!raw) return { result: null, drops: [], recoveries: [] };
    const recoveries: string[] = [];
    // SHAPE layer (#1786): coerce the container a non-strict model wrapped /
    // renamed / bare-arrayed / stringified BEFORE validation, so a real finding
    // set under `{result:…}`, `{findings:…}`, a bare array, or a JSON string is
    // recovered instead of read as `undefined` and silently dropped. Pure and
    // conservative — a canonical `{reasoning,suggestions}` is returned untouched.
    // `[]` is the model saying it found nothing: zero findings, not unusable.
    const unstringified = parseStringifiedSuggestions(raw);
    if (unstringified !== raw) recoveries.push('parsed-field-string');
    let normalized = normalizeEnvelope(
        unstringified,
        'suggestions',
        ['findings', 'codeSuggestions'],
        {
            liftEmptyArray: true,
            salvage: true,
            onRecover: (r) => recoveries.push(r),
        },
    ) as Record<string, unknown> | undefined;
    const isObject =
        !!normalized &&
        typeof normalized === 'object' &&
        !Array.isArray(normalized);
    // Each property of the payload is read once, into this copy; every check
    // below reads the copy.
    if (isObject) normalized = { ...normalized };
    // One finding sent as the whole payload, without the array around it.
    if (
        isObject &&
        normalized.suggestions === undefined &&
        typeof normalized.relevantFile === 'string' &&
        typeof normalized.suggestionContent === 'string'
    ) {
        const { reasoning, reason, ...finding } = normalized;
        normalized = { reasoning, reason, suggestions: [finding] };
        recoveries.push('wrapped-single-finding');
    }
    const meta = {
        organizationId: telemetryMetadata?.organizationId,
        modelId: telemetryMetadata?.modelId,
    };
    const suggestions = isObject ? normalized.suggestions : undefined;
    if (!Array.isArray(suggestions)) {
        if (!opts.silent) {
            const envelope = z
                .object({ suggestions: z.array(z.unknown()) })
                .safeParse(normalized);
            logger.warn({
                message: `${LLM_ENVELOPE_TAG} [DONE-TOOL] FindingsOutput failed Zod validation, falling back to text parsing`,
                context: 'FindingsSchema',
                metadata: {
                    zodErrors: envelope.success
                        ? []
                        : envelope.error.issues.map(
                              (i) => `${i.path.join('.')}: ${i.message}`,
                          ),
                    rawKeys: isObject
                        ? Object.keys(normalized).map(safeKey)
                        : [],
                    payloadType: jsonType(normalized),
                    hasSuggestions: false,
                    recoveries,
                    ...meta,
                },
            });
        }
        return { result: null, drops: [], recoveries };
    }

    // `reasoning` only feeds prose recovery: a missing or non-text one must
    // not cost the findings. `reason` is the name some models give it.
    const { reasoning: given, reason } = normalized;
    const r = given !== undefined ? given : reason;
    const reasoning =
        typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r);

    // Keep each item that is a finding. The old recovery kept the raw array
    // UNVALIDATED, which is how a suggestion without `relevantFile`
    // (kimi-k2.7, observed on a customer instance) reached the finder and
    // crashed the evidence-coverage filter.
    const kept: FindingsOutput['suggestions'] = [];
    const drops: ItemDrop[] = [];
    for (const item of suggestions) {
        const prepared = prepareItem(withContentFallback(item));
        if ('drop' in prepared) {
            drops.push(prepared.drop);
            continue;
        }
        const s = suggestionSchema.safeParse(prepared.value);
        if (!s.success) {
            drops.push(
                describeDrop(prepared.value, item as object, s.error.issues),
            );
            continue;
        }
        // A finding sent without `existingCode` is one main dropped outright
        // (the field was required). Keeping it must not make things worse:
        // with no lines either it has nothing to anchor on — the diff snap
        // would put it on the file's first hunk (snapLinesToDiff in
        // agent-review.stage.ts) — and its fix replaces no code checkFix can
        // see (is-usable-fix.ts), so it goes out as a plain comment. An
        // explicit `existingCode: ""` (an insertion) reads as main read it.
        if (typeof prepared.value.existingCode !== 'string') {
            // Same test as the snap: line 0 is no line.
            if (!s.data.relevantLinesStart || !s.data.relevantLinesEnd) {
                drops.push({
                    ...describeDrop(prepared.value, item as object, [
                        { path: ['relevantLinesStart'] },
                    ]),
                    reason: 'missing-location',
                });
                continue;
            }
            s.data.improvedCode = '';
        }
        kept.push(s.data);
    }
    if (!opts.silent && drops.length > 0) {
        logger.warn({
            message: `${LLM_ENVELOPE_TAG} [DONE-TOOL] dropped ${drops.length} suggestion(s) that failed item validation during partial recovery`,
            context: 'FindingsSchema',
            metadata: {
                kept: kept.length,
                dropped: drops.length,
                drops,
                recoveries,
                ...meta,
            },
        });
    } else if (!opts.silent && recoveries.length > 0) {
        logger.warn({
            message: `${LLM_ENVELOPE_TAG} [DONE-TOOL] recovered an off-shape findings payload`,
            context: 'FindingsSchema',
            metadata: { kept: kept.length, recoveries, ...meta },
        });
    }
    return { result: { reasoning, suggestions: kept }, drops, recoveries };
}

/**
 * Validate and sanitize a done-tool result against the FindingsOutput schema.
 * Returns null if the result is null or holds no findings array, ensuring
 * downstream code never receives a FindingsOutput with missing `suggestions`.
 */
export function sanitizeFindingsResult(
    raw: unknown,
    // Purely for the [LLM_ENVELOPE] logs — this file logged no organizationId
    // at all (prod audit 2026-09-17), so a bucket like "594 dropped-suggestion
    // events" could never be attributed to 1 org vs many without a separate
    // correlationId trace-hunt; nor to a model (#2112). Kept as an untyped
    // inline shape (not @libs/core/log/langfuse's LangfuseTelemetryMetadata)
    // on purpose — this file is deliberately decoupled from that dependency
    // (see file header).
    telemetryMetadata?: FindingsTelemetry,
): FindingsOutput | null {
    return inspectFindingsResult(raw, telemetryMetadata).result;
}
