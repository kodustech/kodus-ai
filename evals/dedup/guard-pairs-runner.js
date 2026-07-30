// Layer-1 guard validation: tests the dedup GUARD in isolation from the LLM.
// For each labeled pair in guard-pairs.json it computes the two candidate guard
// signals — lexical contentSimilarity (the live production one) and embedding
// cosine — then sweeps thresholds to show which signal/threshold best separates
// shouldMerge=true from shouldMerge=false. The dangerous error is a FALSE MERGE
// (shouldMerge=false predicted as merge = over-merge), so the sweep reports the
// safe threshold band (0 false merges) per signal.
//
//   node evals/dedup/guard-pairs-runner.js            # lexical + embedding (needs OpenAI key)
//   node evals/dedup/guard-pairs-runner.js --no-embed # lexical only (CI, no key)
//
// Key: BYOK_OPENAI_API_KEY / API_OPEN_AI_API_KEY (embeddings, text-embedding-3-small).
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
// Import the ACTUAL production primitives so this eval validates the code that
// ships (single source of truth — no drift between eval and production).
const {
    contentSimilarity,
    cosineSimilarity,
    dedupEmbeddingText,
    buildTiebreakPrompt,
    DEDUP_CONTENT_THRESHOLD,
    DEDUP_TIEBREAK_SCHEMA,
} = require('@libs/code-review/infrastructure/agents/engine/dedup-prompt');
const { generateObject, jsonSchema } = require('ai');
const { buildSecondaryModel } = require('../shared/secondary-models');

// LLM tiebreak used ONLY on the ambiguous embedding band, with FULL text of both
// findings (the batch dedup only sees truncated summaries — this is the edge).
// Uses the production prompt + schema.
async function llmSameBug(a, b, model) {
    const { object } = await generateObject({
        model,
        schema: jsonSchema(DEDUP_TIEBREAK_SCHEMA),
        prompt: buildTiebreakPrompt(a, b),
    });
    return !!object.sameBug;
}

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

const DATA = path.join(__dirname, 'guard-pairs.json');
const EMBED_MODEL = 'text-embedding-3-small';

// What text we embed, selectable via --embed=<mode> to compare which channel
// separates best:
//   desc (default) → summary + content  (the semantic bug description)
//   fix            → improvedCode        (the proposed remediation)
//   both           → summary + content + improvedCode
const EMBED_MODE = args.embed || 'desc';
const embedText = (f) => {
    // desc = the production embedding text (dedupEmbeddingText). fix/both kept
    // only for the exploratory A/B that showed desc separates best.
    const desc = dedupEmbeddingText(f);
    const fix = f.improvedCode || '';
    if (EMBED_MODE === 'fix') return fix.trim();
    if (EMBED_MODE === 'both') return `${desc} ${fix}`.trim();
    return desc;
};

async function embedAll(texts) {
    const key = process.env.BYOK_OPENAI_API_KEY || process.env.API_OPEN_AI_API_KEY;
    if (!key) throw new Error('no OpenAI key (BYOK_OPENAI_API_KEY / API_OPEN_AI_API_KEY)');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    const json = await res.json();
    if (!json.data) throw new Error(`embeddings failed: ${JSON.stringify(json).slice(0, 200)}`);
    return json.data.map((d) => d.embedding);
}

/**
 * Sweep thresholds 0.05..0.95 and report, per signal, the widest band that
 * honors every true dup and vetoes every non-dup (0 false merges + 0 missed).
 * Returns { perfect: [lo, hi] | null, bestAcc: {t, correct}, fpFloor }.
 */
function analyzeSignal(rows, get) {
    const trues = rows.filter((r) => r.shouldMerge).map(get);
    const falses = rows.filter((r) => !r.shouldMerge).map(get);
    const minTrue = Math.min(...trues);
    const maxFalse = Math.max(...falses);
    // A clean split exists iff the lowest true-dup score is above the highest
    // non-dup score. The safe threshold band is (maxFalse, minTrue].
    const perfect = minTrue > maxFalse ? [maxFalse, minTrue] : null;
    let best = { t: null, correct: -1, fp: 99 };
    for (let t = 0.05; t <= 0.95001; t += 0.05) {
        let tp = 0, tn = 0, fp = 0, fn = 0;
        for (const r of rows) {
            const merge = get(r) >= t;
            if (r.shouldMerge && merge) tp++;
            else if (r.shouldMerge && !merge) fn++;
            else if (!r.shouldMerge && merge) fp++;
            else tn++;
        }
        const correct = tp + tn;
        // Prefer 0 false-merges first, then max correct.
        if (fp < best.fp || (fp === best.fp && correct > best.correct)) {
            best = { t: +t.toFixed(2), correct, fp, fn };
        }
    }
    return { minTrue, maxFalse, perfect, best };
}

async function main() {
    const ds = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const pairs = ds.pairs || [];
    const doEmbed = !args['no-embed'];

    // lexical (deterministic, always)
    const rows = pairs.map((p) => ({
        id: p.id,
        shouldMerge: !!p.shouldMerge,
        lexical: +contentSimilarity(p.a, p.b).toFixed(4),
    }));

    // embedding (optional / needs key)
    if (doEmbed) {
        const texts = [];
        for (const p of pairs) texts.push(embedText(p.a), embedText(p.b));
        const emb = await embedAll(texts);
        rows.forEach((r, i) => {
            r.cosine = +cosineSimilarity(emb[2 * i], emb[2 * i + 1]).toFixed(4);
        });
    }

    // per-pair table
    console.log(`\nLayer-1 guard pairs · ${rows.length} pairs\n`);
    const head = doEmbed
        ? 'shouldMerge  lexical  cosine   pair'
        : 'shouldMerge  lexical   pair';
    console.log(head);
    console.log('-'.repeat(head.length + 20));
    for (const r of rows) {
        const flag = r.shouldMerge ? 'MERGE ' : 'KEEP  ';
        const lex = r.lexical.toFixed(3).padStart(6);
        const cos = doEmbed ? `  ${r.cosine.toFixed(3).padStart(6)}` : '';
        console.log(`  ${flag}     ${lex}${cos}   ${r.id}`);
    }

    // analysis per signal
    const report = (name, get, prodThreshold) => {
        const a = analyzeSignal(rows, get);
        console.log(`\n── ${name} ──`);
        console.log(`  lowest MERGE score:  ${a.minTrue.toFixed(3)}`);
        console.log(`  highest KEEP score:  ${a.maxFalse.toFixed(3)}`);
        if (a.perfect) {
            const mid = ((a.perfect[0] + a.perfect[1]) / 2).toFixed(3);
            console.log(`  ✅ clean split — safe threshold band (${a.perfect[0].toFixed(3)}, ${a.perfect[1].toFixed(3)}]  → pick ~${mid}`);
        } else {
            console.log(`  ❌ NO clean split — some KEEP scores >= some MERGE scores (this signal cannot separate the set)`);
        }
        console.log(`  best threshold: ${a.best.t}  → correct ${a.best.correct}/${rows.length}, false-merges ${a.best.fp}, missed ${a.best.fn}`);
        if (prodThreshold != null) {
            let fp = 0, fn = 0;
            for (const r of rows) {
                const merge = get(r) >= prodThreshold;
                if (!r.shouldMerge && merge) fp++;
                if (r.shouldMerge && !merge) fn++;
            }
            console.log(`  at production threshold ${prodThreshold}: false-merges ${fp}, missed dups ${fn}`);
        }
    };

    report('LEXICAL  (contentSimilarity)', (r) => r.lexical, DEDUP_CONTENT_THRESHOLD);
    if (doEmbed) report('EMBEDDING (cosine)', (r) => r.cosine, null);

    // Inverted-design band analysis: embedding decides the confident ends,
    // the LLM only adjudicates the ambiguous middle. The dangerous outcomes are
    // the AUTO bands (no LLM checks them): auto-merge a KEEP = over-merge;
    // auto-separate a MERGE = missed dup.
    if (doEmbed && args.band) {
        const [lo, hi] = String(args.band).split(',').map(Number);
        let autoMergeOk = 0, autoMergeBad = 0, autoSepOk = 0, autoSepBad = 0, defer = 0;
        const bad = [];
        for (const r of rows) {
            if (r.cosine >= hi) {
                if (r.shouldMerge) autoMergeOk++;
                else { autoMergeBad++; bad.push(`OVER-MERGE ${r.id} (${r.cosine})`); }
            } else if (r.cosine < lo) {
                if (!r.shouldMerge) autoSepOk++;
                else { autoSepBad++; bad.push(`MISSED DUP ${r.id} (${r.cosine})`); }
            } else defer++;
        }
        console.log(`\n── INVERTED DESIGN · auto-separate < ${lo} | LLM ${lo}–${hi} | auto-merge ≥ ${hi} ──`);
        console.log(`  auto-merge:     ${autoMergeOk} correct, ${autoMergeBad} OVER-MERGE`);
        console.log(`  auto-separate:  ${autoSepOk} correct, ${autoSepBad} missed-dup`);
        console.log(`  → LLM (ambiguous): ${defer}/${rows.length} pairs`);
        if (bad.length) console.log(`  ⚠️  auto-band ERRORS (no LLM catches these):\n     ${bad.join('\n     ')}`);
        else console.log(`  ✅ zero errors in the auto bands — every mistake-prone pair is deferred to the LLM`);
    }

    // Full inverted-pipeline verdict: embedding routes the confident ends, the
    // LLM adjudicates the ambiguous band with full text. Measures end-to-end.
    if (doEmbed && args.verdict && args.band) {
        const [lo, hi] = String(args.band).split(',').map(Number);
        const model = await buildSecondaryModel('gpt-5.4-mini');
        const decisions = await Promise.all(
            rows.map(async (r, i) => {
                let merge, route;
                if (r.cosine >= hi) { merge = true; route = 'auto-merge'; }
                else if (r.cosine < lo) { merge = false; route = 'auto-sep'; }
                else { merge = await llmSameBug(pairs[i].a, pairs[i].b, model); route = 'LLM'; }
                return { id: r.id, shouldMerge: r.shouldMerge, cosine: r.cosine, merge, route };
            }),
        );
        let ok = 0;
        const errs = [];
        for (const d of decisions) {
            if (d.merge === d.shouldMerge) ok++;
            else errs.push(`${d.merge && !d.shouldMerge ? 'OVER-MERGE ' : 'MISSED-DUP '} [${d.route}] ${d.id} cos=${d.cosine}`);
        }
        const llmN = decisions.filter((d) => d.route === 'LLM').length;
        console.log(`\n══ INVERTED PIPELINE VERDICT (embedding → LLM) · band ${lo}–${hi} ══`);
        console.log(`  end-to-end correct: ${ok}/${decisions.length}`);
        console.log(`  routed to LLM: ${llmN}   auto-decided: ${decisions.length - llmN}`);
        if (errs.length) console.log(`  ⚠️  errors:\n     ${errs.join('\n     ')}`);
        else console.log(`  ✅ ZERO errors end-to-end (0 over-merge, 0 missed dup)`);
    }

    console.log('');
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
