// Invokes the REAL production dedup decision on a list of suggestions: the same
// prompt + schema (libs/.../engine/dedup-prompt.ts) through the same entry point
// the stage uses — `LLM.run` (agent-review.stage.ts, deduplicateSuggestions) —
// so the eval measures the executor's recovery ladder (json_object contract,
// deterministic repair, re-ask) too, not a bare SDK call.
// Loaded via ts-node so it reads the live TS modules — no drift.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) {
    dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
}
// Platform OpenAI key for the dedup embedding tier, captured before
// applyModelEnv rewrites API_OPEN_AI_API_KEY with the scenario's BYOK key —
// in production the embedder never sees the BYOK key either.
const PLATFORM_OPENAI_KEY = process.env.API_OPEN_AI_API_KEY;

const { jsonSchema } = require('ai');
const {
    buildDedupPrompt,
    DEDUP_SCHEMA,
    contentSimilarity,
    DEDUP_CONTENT_THRESHOLD,
    DEDUP_EMBEDDING_LOW,
    DEDUP_EMBEDDING_HIGH,
    cosineSimilarity,
    dedupEmbeddingText,
    DEDUP_TIEBREAK_SCHEMA,
    buildTiebreakPrompt,
} = require('@libs/code-review/infrastructure/agents/engine/dedup-prompt');
const { SECONDARY_BASELINE } = require('../shared/secondary-models');
const { TIER0, applyModelEnv } = require('../shared/tier0-models');


// Aliases kept so older CLI/scripts (--model=kimi-k2.7, gemini-3-flash) still work.
const DEDUP_ALIASES = {
    'gemini-3-flash': 'gemini-3-flash-preview',
    'kimi-k2.7': 'kimi-k2.7-code',
};
// Every model routes through tier0-models (evals/AGENTS.md): the id sets the
// env the engine's managed/self-hosted default reads, the same way prod does.
const DEDUP_MODELS = TIER0;

/**
 * @param {Array} suggestions
 * @param {string} modelKey   tier0-models id (default gpt-5.4-mini = prod)
 */
async function runDedup(suggestions, modelKey = SECONDARY_BASELINE, opts = {}) {
    if (suggestions.length <= 1) {
        return { groups: [], unique: suggestions.map((_, i) => i), kept: suggestions.map((_, i) => i), dropped: [], unmentioned: [], raw: { skipped: true } };
    }
    const resolved = DEDUP_ALIASES[modelKey] || modelKey;
    if (!DEDUP_MODELS[resolved]) {
        throw new Error(`unknown dedup model '${modelKey}' (have: ${Object.keys(DEDUP_MODELS).join(', ')})`);
    }
    applyModelEnv(resolved);
    // Required after the env is set, like the stage: no BYOK slot → the
    // managed/env default the id above now points at.
    const { LLM } = require('@libs/llm/llm');

    const object = await LLM.run({
        schema: jsonSchema(DEDUP_SCHEMA),
        user: buildDedupPrompt(suggestions),
        runName: 'code-review-dedup',
        spanName: 'code-review::dedup',
        // Rota de assinatura (Codex/SDK): o modelo pronto, senao o LLM.run cai no default do env.
        ...(opts.prebuiltModel ? { prebuiltModel: opts.prebuiltModel } : {}),
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
        // 'tiered' → the full production guard (agent-review.stage resolveDedupMerge,
        // PR #1527): lexical >= threshold honors; else embedding cosine (platform
        // OpenAI embedder) >= HIGH honors, < LOW vetoes, in between the BYOK model
        // breaks the tie. Any failure vetoes, like production.
        const embCache = new Map();
        const embed = async (i) => {
            if (embCache.has(i)) return embCache.get(i);
            let v = null;
            try {
                const { buildPlatformEmbedder } = require('@libs/common/utils/document');
                const { embed: aiEmbed } = require('ai');
                const model = buildPlatformEmbedder({ apiKey: PLATFORM_OPENAI_KEY });
                const text = dedupEmbeddingText(suggestions[i]);
                if (model && text) v = (await aiEmbed({ model, value: text })).embedding;
            } catch { v = null; }
            embCache.set(i, v);
            return v;
        };
        const tiebreak = async (a, b) => {
            try {
                const { LLM } = require('@libs/llm/llm');
                const out = await LLM.run({
                    schema: jsonSchema(DEDUP_TIEBREAK_SCHEMA),
                    user: buildTiebreakPrompt(a, b),
                    runName: 'dedup-tiebreak',
                    ...(opts.prebuiltModel ? { prebuiltModel: opts.prebuiltModel } : {}),
                });
                return typeof out?.sameBug === 'boolean' ? out.sameBug : null;
            } catch { return null; }
        };
        const tiered = async (d) => {
            const dup = suggestions[d.idx], rep = suggestions[d.keptInto];
            if (contentSimilarity(dup, rep) >= DEDUP_CONTENT_THRESHOLD) return 'lexical';
            const [va, vb] = await Promise.all([embed(d.idx), embed(d.keptInto)]);
            if (!va || !vb) return { veto: 'veto-sem-embedding' };
            const cos = cosineSimilarity(va, vb);
            if (cos >= DEDUP_EMBEDDING_HIGH) return 'embedding-high';
            if (cos < DEDUP_EMBEDDING_LOW) return { veto: 'veto-embedding-low' };
            const tb = await tiebreak(dup, rep);
            return tb === true ? 'tiebreak-sim' : { veto: tb === false ? 'veto-tiebreak-nao' : 'veto-tiebreak-erro' };
        };
        // 'record' → honor every proposed merge, but store each pair's lexical
        // score, embedding cosine and tiebreak verdict, so guard variants can be
        // replayed offline on the SAME LLM grouping.
        if (opts.guard === 'record') {
            opts.pairs = await Promise.all(dropped.map(async (d) => {
                const dup = suggestions[d.idx], rep = suggestions[d.keptInto];
                const [va, vb] = await Promise.all([embed(d.idx), embed(d.keptInto)]);
                return { idx: d.idx, keptInto: d.keptInto, lex: contentSimilarity(dup, rep), cos: va && vb ? cosineSimilarity(va, vb) : null, tb: await tiebreak(dup, rep) };
            }));
        }
        const survives = [];
        const guardReasons = {};
        for (const d of dropped) {
            const ok = opts.guard === 'record' ? true : opts.guard === 'tiered'
                ? await tiered(d).then((r) => { const k = typeof r === 'string' ? r : r.veto; guardReasons[k] = (guardReasons[k] || 0) + 1; return typeof r === 'string'; })
                : keepMerge(suggestions[d.idx], suggestions[d.keptInto]);
            if (ok) survives.push(d);
            else kept.add(d.idx); // un-merge, keep it
        }
        opts.guardReasons = guardReasons;
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
