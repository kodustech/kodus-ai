// Invokes the REAL production dedup decision (prompt + schema from
// libs/.../engine/dedup-prompt.ts) on a list of suggestions, on ANY model — so we
// can A/B which small model dedups well.
// Loaded via ts-node so it reads the live TS prompt module — no drift.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateObject, jsonSchema } = require('ai');
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
 * @param {string} modelKey   key into SECONDARY_MODELS (default gpt-5.4-mini = prod)
 */
async function runDedup(suggestions, modelKey = SECONDARY_BASELINE, opts = {}) {
    if (suggestions.length <= 1) {
        return { groups: [], unique: suggestions.map((_, i) => i), kept: suggestions.map((_, i) => i), dropped: [], unmentioned: [], raw: { skipped: true } };
    }
    const resolved = DEDUP_ALIASES[modelKey] || modelKey;
    if (!DEDUP_MODELS[resolved] && !SECONDARY_MODELS[resolved]) {
        throw new Error(`unknown dedup model '${modelKey}' (have: ${Object.keys(DEDUP_MODELS).join(', ')})`);
    }
    const model = await buildSecondaryModel(resolved);

    const { object } = await generateObject({
        model,
        schema: jsonSchema(DEDUP_SCHEMA),
        prompt: buildDedupPrompt(suggestions, normSeverity),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });

    const rawGroups = Array.isArray(object?.groups) ? object.groups : [];
    const rawUnique = Array.isArray(object?.unique) ? object.unique : [];
    const n = suggestions.length;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < n;

    // Small models often drift from the exact schema (kimi returns
    // {representative:"[0] file", discarded:[]} instead of {keep:0,duplicates:[]}).
    // Coerce index | "[i] ..." → number; accept keep|representative and
    // duplicates|discarded. Track whether the EXACT schema was honored — that
    // reliability signal is itself a model-selection criterion for dedup.
    let schemaExact = true;
    const toIdx = (v) => {
        if (Number.isInteger(v)) return v;
        if (typeof v === 'string') { const m = v.match(/^\s*\[(\d+)\]/); if (m) { schemaExact = false; return +m[1]; } }
        schemaExact = false; return NaN;
    };
    const groups = rawGroups.map((g) => {
        if (g && (g.keep === undefined) && g.representative !== undefined) schemaExact = false;
        const keep = toIdx(g?.keep ?? g?.representative);
        const dupsRaw = g?.duplicates ?? g?.discarded ?? [];
        return { keep, duplicates: (Array.isArray(dupsRaw) ? dupsRaw : []).map(toIdx) };
    });
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

    return { groups, unique, kept: [...kept].sort((a, b) => a - b), dropped, unmentioned, schemaExact, noOp, raw: object };
}

module.exports = { runDedup, DEDUP_MODELS };
