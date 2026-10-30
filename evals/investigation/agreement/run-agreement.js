#!/usr/bin/env node
/**
 * Judge agreement study for the eval-judge swap (issue #1447).
 *
 * Labels every pair in pairs.json with the reference judge (Sonnet) and each
 * candidate judge (gpt-5.4-mini, gemini-*, ...), then reports — treating the
 * Sonnet label as ground truth for the MATCH class:
 *   accuracy   — fraction of pairs where candidate == Sonnet
 *   precision  — of candidate's "match", how many Sonnet also matched
 *   recall     — of Sonnet's "match", how many candidate caught
 *   F1, Cohen's kappa (chance-corrected agreement)
 * plus per-candidate mean latency, and a disagreement dump for inspection.
 *
 * A candidate is safe to promote when it agrees with Sonnet on the match
 * decision tightly enough that downstream recall/dedup means don't shift beyond
 * noise (see targets.json ratchet). Reference labels are cached in
 * labels.<model>.json so re-runs only pay for new judges.
 *
 *   node run-agreement.js                          # sonnet + defaults
 *   node run-agreement.js --candidates=gpt-5.4-mini,gemini-2.5-flash
 *   node run-agreement.js --reference=claude-sonnet-4-6 --limit=50
 */
const fs = require('fs');
const path = require('path');
const { loadKeyForModel, matchCommentWith, providerFor } = require('../recall-judge');

const DIR = __dirname;
const PAIRS = path.join(DIR, 'pairs.json');
const OUT = path.join(DIR, 'agreement-report.json');
const CONCURRENCY = 6;

function parseArgs(argv) {
    const out = {
        reference: 'claude-sonnet-4-6',
        candidates: ['gpt-5.4-mini', 'claude-haiku-4-5', 'gemini-3-flash-preview'],
        limit: null,
    };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        const [, k, v] = m;
        if (k === 'reference') out.reference = v;
        else if (k === 'candidates') out.candidates = v.split(',').map((s) => s.trim()).filter(Boolean);
        else if (k === 'limit') out.limit = Number(v);
    }
    return out;
}

// Label all pairs with one model, cached to labels.<model>.json. Returns a map
// id → { label: bool|null, ms } (null = judge error after retries).
async function labelAll(model, pairs) {
    const cacheFile = path.join(DIR, `labels.${model.replace(/[^\w.-]+/g, '-')}.json`);
    let cache = {};
    try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
        /* no cache */
    }
    const key = loadKeyForModel(model);
    if (!key) throw new Error(`no API key for judge ${model} (${providerFor(model)})`);

    const todo = pairs.filter((p) => !(p.id in cache));
    let done = 0;
    let failed = 0;
    async function worker(queue) {
        for (const p of queue) {
            const t0 = Date.now();
            let label = null;
            try {
                // eslint-disable-next-line no-await-in-loop
                label = await matchCommentWith(model, key, p.golden, p.candidate);
            } catch (e) {
                failed++;
                if (failed <= 3) console.warn(`  ${model} ERR ${p.id}: ${String(e.message).slice(0, 100)}`);
            }
            cache[p.id] = { label, ms: Date.now() - t0 };
            done++;
            if (done % 25 === 0) {
                process.stdout.write(`  ${model}: ${done}/${todo.length}\r`);
                fs.writeFileSync(cacheFile, JSON.stringify(cache));
            }
        }
    }
    // Simple fixed-size worker pool.
    const chunks = Array.from({ length: CONCURRENCY }, () => []);
    todo.forEach((p, i) => chunks[i % CONCURRENCY].push(p));
    await Promise.all(chunks.map(worker));
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    if (todo.length) console.log(`  ${model}: labeled ${todo.length} pairs (${failed} errors)`);
    else console.log(`  ${model}: all ${pairs.length} pairs cached`);
    return cache;
}

// Confusion of candidate vs reference on the MATCH (true) class.
function agreement(refMap, candMap, pairs) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let both = 0;
    let agree = 0;
    let refMatch = 0;
    let candMatch = 0;
    const disagreements = [];
    let latSum = 0;
    let latN = 0;
    for (const p of pairs) {
        const r = refMap[p.id]?.label;
        const c = candMap[p.id]?.label;
        if (typeof candMap[p.id]?.ms === 'number') {
            latSum += candMap[p.id].ms;
            latN++;
        }
        if (typeof r !== 'boolean' || typeof c !== 'boolean') continue; // skip judge errors
        both++;
        if (r) refMatch++;
        if (c) candMatch++;
        if (r === c) agree++;
        if (r && c) tp++;
        else if (!r && c) fp++;
        else if (r && !c) fn++;
        else tn++;
        if (r !== c) {
            disagreements.push({ id: p.id, ref: r, cand: c, golden: p.golden.slice(0, 90), candidate: p.candidate.slice(0, 120) });
        }
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    // null only when a rate is undefined (no denominator); a real 0 precision or
    // 0 recall must report F1 = 0, not null (a truthy guard would swallow it).
    const f1 =
        precision === null || recall === null
            ? null
            : precision + recall === 0
              ? 0
              : (2 * precision * recall) / (precision + recall);
    const accuracy = both ? agree / both : null;
    // Cohen's kappa
    const po = accuracy;
    const pRef = both ? refMatch / both : 0;
    const pCand = both ? candMatch / both : 0;
    const pe = pRef * pCand + (1 - pRef) * (1 - pCand);
    const kappa = po !== null && pe < 1 ? (po - pe) / (1 - pe) : null;
    return {
        pairs: both,
        refMatchRate: both ? refMatch / both : null,
        candMatchRate: both ? candMatch / both : null,
        tp,
        fp,
        fn,
        tn,
        accuracy,
        precision,
        recall,
        f1,
        kappa,
        meanLatencyMs: latN ? Math.round(latSum / latN) : null,
        disagreements,
    };
}

async function main() {
    const args = parseArgs(process.argv);
    if (!fs.existsSync(PAIRS)) {
        console.error(`pairs.json missing — run build-pairs.js first (${PAIRS})`);
        process.exit(2);
    }
    const data = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
    let pairs = data.pairs || [];
    if (Number.isFinite(args.limit)) pairs = pairs.slice(0, args.limit);
    console.log(`agreement study · ${pairs.length} pairs · reference=${args.reference} · candidates=${args.candidates.join(', ')}\n`);

    console.log('labeling reference…');
    const refMap = await labelAll(args.reference, pairs);

    const report = { reference: args.reference, pairCount: pairs.length, candidates: {} };
    for (const cand of args.candidates) {
        console.log(`labeling candidate ${cand}…`);
        let candMap;
        try {
            candMap = await labelAll(cand, pairs);
        } catch (e) {
            console.warn(`  SKIP ${cand}: ${e.message}`);
            report.candidates[cand] = { error: e.message };
            continue;
        }
        report.candidates[cand] = agreement(refMap, candMap, pairs);
    }

    // Reference self-stats (match rate, latency) for context.
    const refLat = pairs.map((p) => refMap[p.id]?.ms).filter((x) => typeof x === 'number');
    report.referenceStats = {
        matchRate: (() => {
            const labels = pairs.map((p) => refMap[p.id]?.label).filter((x) => typeof x === 'boolean');
            return labels.length ? labels.filter(Boolean).length / labels.length : null;
        })(),
        meanLatencyMs: refLat.length ? Math.round(refLat.reduce((a, b) => a + b, 0) / refLat.length) : null,
    };

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

    // Pretty summary.
    console.log('\n════ agreement vs ' + args.reference + ' ════');
    const pct = (x) => (x === null || x === undefined ? ' n/a' : (x * 100).toFixed(1) + '%');
    console.log(
        `reference match-rate ${pct(report.referenceStats.matchRate)} · mean latency ${report.referenceStats.meanLatencyMs}ms\n`,
    );
    const head = 'candidate'.padEnd(26) + 'acc     kappa   prec    rec     F1      matchR  lat';
    console.log(head);
    for (const [name, r] of Object.entries(report.candidates)) {
        if (r.error) {
            console.log(name.padEnd(26) + 'ERROR: ' + r.error.slice(0, 60));
            continue;
        }
        console.log(
            name.padEnd(26) +
                [pct(r.accuracy), (r.kappa ?? NaN).toFixed(2).padStart(5), pct(r.precision), pct(r.recall), pct(r.f1), pct(r.candMatchRate), (r.meanLatencyMs || 0) + 'ms']
                    .map((s, i) => (i === 1 ? s : String(s).padEnd(8)))
                    .join(' '),
        );
    }
    console.log(`\nfull report + disagreements → ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
