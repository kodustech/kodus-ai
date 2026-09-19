// Invokes the REAL production dedup decision (prompt + schema from
// libs/.../engine/dedup-prompt.ts) on a list of suggestions, on ANY model — so we
// can A/B which small model dedups well.
// Loaded via ts-node so it reads the live TS prompt module — no drift.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateText, jsonSchema, tool } = require('ai');
const {
    buildDedupPrompt,
    DEDUP_SCHEMA,
    contentSimilarity,
    DEDUP_CONTENT_THRESHOLD,
} = require('@libs/code-review/infrastructure/agents/engine/dedup-prompt');
const {
    SECONDARY_MODELS,
    SECONDARY_BASELINE,
    buildSecondaryModel,
} = require('../shared/secondary-models');

const normSeverity = (s) => (s == null ? 'medium' : String(s).toLowerCase());

// Aliases kept so older CLI/scripts (--model=kimi-k2.7, gemini-3-flash) still work.
const DEDUP_ALIASES = {
    'gemini-3-flash': 'gemini-3-flash-preview',
    'kimi-k2.7': 'kimi-k2.7-code',
};
const DEDUP_MODELS = { ...SECONDARY_MODELS, ...Object.fromEntries(
    Object.entries(DEDUP_ALIASES).map(([alias, target]) => [alias, SECONDARY_MODELS[target]]),
) };

/**
 * @param {Array} suggestions
 * @param {string} modelKey   key into SECONDARY_MODELS (default gpt-5.4-mini = prod).
 *                            Ignored when opts.model is set.
 * @param {object} opts
 * @param {object} [opts.model] Pre-built AI SDK model — bypasses SECONDARY_MODELS/
 *                            buildSecondaryModel entirely. Production runs dedup on
 *                            "the bare resolved model slot" (agent-review.stage.ts
 *                            deduplicateSuggestions: `resolvedSlot ?? undefined`) —
 *                            i.e. the SAME model doing the review, not a fixed cheap
 *                            one. Pass the review model here to match that; omit
 *                            (modelKey path) only when deliberately A/B-ing which
 *                            secondary model dedups best (the evals/dedup use case).
 */
async function runDedup(suggestions, modelKey = SECONDARY_BASELINE, opts = {}) {
    if (suggestions.length <= 1) {
        return { groups: [], unique: suggestions.map((_, i) => i), kept: suggestions.map((_, i) => i), dropped: [], unmentioned: [], raw: { skipped: true }, usage: null };
    }
    let model = opts.model;
    if (!model) {
        const resolved = DEDUP_ALIASES[modelKey] || modelKey;
        if (!DEDUP_MODELS[resolved] && !SECONDARY_MODELS[resolved]) {
            throw new Error(`unknown dedup model '${modelKey}' (have: ${Object.keys(DEDUP_MODELS).join(', ')})`);
        }
        model = await buildSecondaryModel(resolved);
    }

    // FORCED TOOL CALL, not generateObject/json_schema. Measured 2026-09-16:
    // json_schema is advisory on several providers — Muse Spark answered with
    // `{"22 inputs -> 8 to keep, …": "CONSERVATIVE …"}` (prose as a KEY: the
    // grouping it decided never reached us) and Kimi drifted too, both landing
    // on the keep-all noOp fallback. That silently benchmarks those models
    // WITHOUT dedup while others get it — the finder never has this problem
    // because its payload rides a tool call the provider validates
    // (submitResult, see finder.agent.ts). Same mechanism here: one tool, an
    // explicit schema, toolChoice forcing it. The raw args ARE the answer.
    const dedupTools = {
        submitDedup: tool({
            description:
                'Submit the duplicate grouping for the listed suggestions. You MUST call this tool with your grouping — it is the only way to answer.',
            inputSchema: jsonSchema(DEDUP_SCHEMA),
            execute: async () => ({ output: 'recorded' }),
        }),
    };
    const dedupPrompt = buildDedupPrompt(suggestions, normSeverity, {
        mergeRootCause: opts.mergeRootCause === true,
    });
    const callArgs = (toolChoice) => ({
        model,
        tools: dedupTools,
        ...(toolChoice ? { toolChoice } : {}),
        prompt: dedupPrompt,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });
    let result;
    try {
        result = await generateText(
            callArgs({ type: 'tool', toolName: 'submitDedup' }),
        );
    } catch (err) {
        // Meta's Muse endpoint (and other partial OpenAI-compatible upstreams)
        // reject a named tool_choice outright: `only "auto" is supported`.
        // Retry on `auto` — the tool + the prompt's "you MUST call it" still
        // get the structured answer on every model tried; without this the
        // call throws and the caller keeps ALL suggestions (no dedup at all).
        if (/tool_choice|tool choice/i.test(String(err?.message ?? ''))) {
            result = await generateText(callArgs(undefined));
        } else {
            throw err;
        }
    }
    const usage = result.usage;
    const call = (result.toolCalls || []).find(
        (c) => (c.toolName ?? c.name) === 'submitDedup',
    );
    let object = call?.input ?? call?.args ?? {};
    if (typeof object === 'string') {
        try {
            object = JSON.parse(object);
        } catch {
            object = {};
        }
    }

    // DeepSeek v4.1 (observed 2026-09-16, with the 3-type mergeRootCause
    // prompt) sometimes invents a richer envelope: `duplicate_groups` with a
    // `representative` OBJECT ({id, line, summary, ...}) instead of a bare
    // index. Same drift class as the rest — coerce it, don't keep-all: the
    // noOp fallback silently turned every merge into a no-merge (20→20),
    // which reads as "model chose not to group" when it actually grouped
    // correctly and only the envelope drifted.
    const rawGroups = Array.isArray(object?.groups)
        ? object.groups
        : Array.isArray(object?.duplicate_groups)
          ? object.duplicate_groups
          : [];
    // DeepSeek (observed 2026-09-15) returns `singletons` instead of `unique`
    // for the same meaning — same drift class as representative/discarded
    // below. Missing this silently DROPS real, non-duplicate findings (they
    // land in neither kept nor dropped), which is a recall regression, not
    // just a precision one — worse than the schema-drift cases already
    // handled here.
    const rawUnique = Array.isArray(object?.unique)
        ? object.unique
        : Array.isArray(object?.singletons)
          ? object.singletons
          : [];
    const n = suggestions.length;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < n;

    // Small models often drift from the exact schema (kimi returns
    // {representative:"[0] file", discarded:[]} instead of {keep:0,duplicates:[]}).
    // Coerce index | "[i] ..." → number; accept keep|representative and
    // duplicates|discarded. Track whether the EXACT schema was honored — that
    // reliability signal is itself a model-selection criterion for dedup.
    let schemaExact = true;
    if (!Array.isArray(object?.unique) && Array.isArray(object?.singletons)) {
        schemaExact = false;
    }
    if (!Array.isArray(object?.groups) && Array.isArray(object?.duplicate_groups)) {
        schemaExact = false;
    }
    const toIdx = (v) => {
        if (Number.isInteger(v)) return v;
        if (typeof v === 'string') { const m = v.match(/^\s*\[(\d+)\]/); if (m) { schemaExact = false; return +m[1]; } }
        // representative-as-OBJECT drift: {id: 14, ...} or {index: 13, ...}.
        if (v && typeof v === 'object') {
            const idLike = [v.id, v.index, v.idx].find(Number.isInteger);
            if (idLike !== undefined) { schemaExact = false; return idLike; }
        }
        schemaExact = false; return NaN;
    };
    // Field names drift per CALL, not per model (observed in one session:
    // keep/duplicates, representative/duplicates, representative{id|index}/
    // duplicates, representative_id/duplicate_ids) — so resolve by key
    // PATTERN instead of enumerating spellings: any /rep|keep/ key that
    // coerces to an index is the representative; any /dup|discard|member/
    // key holding an array is the duplicates list.
    const groupFields = (g) => {
        if (!g || typeof g !== 'object') return { keep: NaN, duplicates: [] };
        let keep = toIdx(g.keep ?? g.representative);
        let dups = Array.isArray(g.duplicates) ? g.duplicates : undefined;
        if (!valid(keep) || !dups) {
            for (const [k, v] of Object.entries(g)) {
                if (!valid(keep) && /rep|keep/i.test(k)) {
                    const c = toIdx(v);
                    if (valid(c)) { keep = c; schemaExact = false; }
                }
                if (!dups && /dup|discard|member/i.test(k) && Array.isArray(v)) {
                    dups = v;
                    schemaExact = false;
                }
            }
        }
        return { keep, duplicates: (dups ?? []).map(toIdx) };
    };
    const groups = rawGroups
        .map((g) => {
            if (g && (g.keep === undefined) && g.representative !== undefined) schemaExact = false;
            return groupFields(g);
        })
        // A group whose representative could not be resolved must be VOID, not
        // honored: honoring it would drop the duplicates while keeping no
        // representative — losing every finding in the group. Voided members
        // fall through to `unmentioned` and are kept by the caller.
        .filter((g) => valid(g.keep));
    const unique = rawUnique.map(toIdx);

    const kept = new Set();
    for (const i of unique) if (valid(i)) kept.add(i);
    for (const g of groups) if (valid(g?.keep)) kept.add(g.keep);

    const seenAsDup = new Set();
    for (const g of groups) for (const d of g?.duplicates || []) if (valid(d) && d !== g.keep) seenAsDup.add(d);
    const dropped = [];
    for (const d of seenAsDup) if (!kept.has(d)) {
        const into = groups.find((g) => (g.duplicates || []).includes(d))?.keep;
        dropped.push({ idx: d, keptInto: into });
    }

    // Deterministic guard: only honor a merge when the duplicate is the SAME file
    // AND overlapping lines as its representative (exact dup — can't be a distinct
    // bug). Cross-location merges (where over-merge of different bugs happens) are
    // reversed: the "duplicate" is kept instead of dropped. Trades under-merge for
    // ~zero over-merge.
    if (opts.guard) {
        const sameFileOverlap = (a, b) => {
            if (!a || !b || a.relevantFile !== b.relevantFile) return false;
            const as = +a.relevantLinesStart, ae = +a.relevantLinesEnd;
            const bs = +b.relevantLinesStart, be = +b.relevantLinesEnd;
            if (![as, ae, bs, be].every(Number.isFinite)) return false;
            return as <= be && bs <= ae;
        };
        // 'tight' → same file AND the overlap covers >=50% of the LARGER range.
        // Blocks the real hole: a broad finding (whole function) swallowing a
        // narrow distinct bug inside it (overlap real but tiny vs the big range).
        const tightOverlap = (a, b) => {
            if (!sameFileOverlap(a, b)) return false;
            const lenA = Math.abs(+a.relevantLinesEnd - +a.relevantLinesStart) + 1;
            const lenB = Math.abs(+b.relevantLinesEnd - +b.relevantLinesStart) + 1;
            const ov = Math.min(+a.relevantLinesEnd, +b.relevantLinesEnd) - Math.max(+a.relevantLinesStart, +b.relevantLinesStart) + 1;
            const ratio = opts.tightRatio != null ? opts.tightRatio : 0.5;
            return ov >= ratio * Math.max(lenA, lenB);
        };
        // 'content' → allow a merge only if the two findings actually SAY the same
        // thing: word-overlap >= threshold (the SAME contentSimilarity production
        // uses — imported, no drift). Targets "same bug vs different bug" directly.
        // 'exact'    → survive iff same-file + any overlap (block ALL else).
        // 'tight'    → exact, but require >=ratio overlap of the larger range.
        // 'samefile' → block ONLY same-file-non-overlapping; allow cross-file too.
        // 'content'  → allow iff the two findings' text is similar enough.
        const keepMerge = (dup, rep) => {
            const sameFile = dup && rep && dup.relevantFile === rep.relevantFile;
            if (opts.guard === 'content') return contentSimilarity(dup, rep) >= (opts.contentThresh != null ? opts.contentThresh : DEDUP_CONTENT_THRESHOLD);
            if (opts.guard === 'samefile') return !sameFile || sameFileOverlap(dup, rep);
            if (opts.guard === 'tight') return tightOverlap(dup, rep);
            return sameFileOverlap(dup, rep); // 'exact'
        };
        const survives = [];
        for (const d of dropped) {
            if (keepMerge(suggestions[d.idx], suggestions[d.keptInto])) survives.push(d);
            else kept.add(d.idx); // un-merge, keep it
        }
        dropped.length = 0;
        dropped.push(...survives);
    }

    const accounted = new Set([...kept, ...dropped.map((x) => x.idx)]);
    const unmentioned = [];
    for (let i = 0; i < n; i++) if (!accounted.has(i)) unmentioned.push(i);

    // Production safety: if the model returned nothing usable, keep all (the
    // stage does the same). Flag it — a model that frequently no-ops here is a
    // poor dedup driver regardless of how "safe" keeping-all is.
    let noOp = false;
    if (kept.size === 0 && dropped.length === 0) {
        noOp = true;
        for (let i = 0; i < n; i++) kept.add(i);
        unmentioned.length = 0;
    }

    return { groups, unique, kept: [...kept].sort((a, b) => a - b), dropped, unmentioned, schemaExact, noOp, raw: object, usage };
}

module.exports = { runDedup, DEDUP_MODELS };
