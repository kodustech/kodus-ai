#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * A/B post-processing filters over a FIXED candidate set.
 *
 * Every filter comparison so far has been a full 30-PR run against another full
 * 30-PR run, which drags the pipeline's own run-to-run spread (+-0.026 F1,
 * measured over four identical runs) into a question that is supposed to be
 * about the filter alone. Four runs of the same config found the same 34
 * goldens give or take two — so any filter effect smaller than that was
 * unreadable.
 *
 * This replays `trace.preFilterCandidates` from a completed run and applies a
 * different filter to it. Same candidates every time, so the only thing that
 * moves is the filter. No finder, no shard, no agent loop — only the filter's
 * own call plus judging.
 *
 * Usage:
 *   node evals/investigation/offline-filter-ab.js --dump=<dir> [--filters=none,dedup,reducer,reducer-strict] [--model=gpt-5.6-sol@sub]
 */
const fs = require('fs');
const path = require('path');

const { matchCommentDetailed, loadJudgeKey } = require('./recall-judge');
const { createModel } = require('./agent-provider');

const DATASETS = path.join(__dirname, 'datasets');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const DUMP = arg('dump');
const FILTERS = arg('filters', 'none,dedup,reducer,reducer-strict').split(',');
const MODEL = arg('model', 'gpt-5.6-sol@sub');
const CONCURRENCY = Number(arg('concurrency', '4'));

if (!DUMP) {
    console.error('need --dump=<directory with *.raw.txt>');
    process.exit(1);
}

function goldensFor(caseId) {
    for (const f of fs.readdirSync(DATASETS)) {
        if (!f.endsWith('.json')) continue;
        let vars;
        try {
            vars = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'))[0].vars;
        } catch {
            continue;
        }
        if (vars.caseId !== caseId) continue;
        const g =
            typeof vars.goldenComments === 'string'
                ? JSON.parse(vars.goldenComments)
                : vars.goldenComments || [];
        return g.map((x) => x.comment || String(x));
    }
    return [];
}

function loadCases() {
    const out = [];
    for (const f of fs.readdirSync(DUMP)) {
        if (!f.endsWith('.raw.txt')) continue;
        let d;
        try {
            d = JSON.parse(fs.readFileSync(path.join(DUMP, f), 'utf8'));
        } catch {
            continue;
        }
        const pre = d.trace?.preFilterCandidates;
        if (!pre) continue;
        out.push({
            caseId: d.caseId,
            candidates: pre,
            goldens: goldensFor(d.caseId),
        });
    }
    return out;
}

// --- filters -------------------------------------------------------------

let MODEL_OBJ = null;

async function applyFilter(name, candidates) {
    if (name === 'none') return candidates;
    if (candidates.length <= 1) return candidates;

    if (name === 'dedup') {
        const { runDedup } = require('../dedup/dedup-runner.js');
        const r = await runDedup(candidates, undefined, {
            model: MODEL_OBJ,
            mergeRootCause: true,
        });
        const keep = new Set(r.unique ?? r.kept ?? []);
        return candidates.filter((_, i) => keep.has(i));
    }

    if (name === 'reducer' || name === 'reducer-strict') {
        const { runReducer } = require('../dedup/reducer-runner.js');
        const r = await runReducer(candidates, {
            model: MODEL_OBJ,
            strict: name === 'reducer-strict',
        });
        return r.kept.map((i) => candidates[i]).filter(Boolean);
    }

    throw new Error(`unknown filter ${name}`);
}

// --- scoring (Martian parity: tp counts GOLDENS matched, pooled) ----------

/** The judge takes a STRING (it does `String(candidate)`), so a finding object
 *  arrives as "[object Object]" and matches nothing. Same flattening
 *  recall-assertion.js uses, so the scores stay comparable. */
function findingText(f) {
    if (!f || typeof f !== 'object') return String(f || '');
    return [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile]
        .filter(Boolean)
        .join(' — ');
}

async function score(apiKey, goldens, findings) {
    const goldenMatched = new Array(goldens.length).fill(false);
    const bestConf = new Array(goldens.length).fill(0);
    const candMatched = new Array(findings.length).fill(false);

    for (let gi = 0; gi < goldens.length; gi++) {
        for (let fi = 0; fi < findings.length; fi++) {
            const { match, confidence } = await matchCommentDetailed(
                apiKey,
                goldens[gi],
                findingText(findings[fi]),
            );
            if (match && confidence > bestConf[gi]) {
                bestConf[gi] = confidence;
                goldenMatched[gi] = true;
                candMatched[fi] = true;
            }
        }
    }
    const tp = goldenMatched.filter(Boolean).length;
    return {
        tp,
        fp: candMatched.filter((m) => !m).length,
        fn: goldens.length - tp,
    };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await fn(items[idx], idx);
            }
        }),
    );
    return out;
}

(async () => {
    const apiKey = await loadJudgeKey();
    MODEL_OBJ = await createModel({ provider: 'tier0', model: MODEL });
    const cases = loadCases();
    if (!cases.length) {
        console.error(`no cases with preFilterCandidates in ${DUMP}`);
        process.exit(1);
    }
    const totalCands = cases.reduce((a, c) => a + c.candidates.length, 0);
    const totalGold = cases.reduce((a, c) => a + c.goldens.length, 0);
    console.log(
        `${cases.length} PRs | ${totalCands} candidatos | ${totalGold} goldens\n`,
    );

    const table = [];
    for (const name of FILTERS) {
        const rows = await mapLimit(cases, CONCURRENCY, async (c) => {
            let kept;
            try {
                kept = await applyFilter(name, c.candidates);
            } catch (err) {
                console.log(`  ${name} falhou em ${c.caseId}: ${String(err).slice(0, 90)}`);
                kept = c.candidates;
            }
            const s = await score(apiKey, c.goldens, kept);
            return { ...s, kept: kept.length };
        });
        const tp = rows.reduce((a, r) => a + r.tp, 0);
        const fp = rows.reduce((a, r) => a + r.fp, 0);
        const fn = rows.reduce((a, r) => a + r.fn, 0);
        const kept = rows.reduce((a, r) => a + r.kept, 0);
        const P = tp + fp ? tp / (tp + fp) : 0;
        const R = tp + fn ? tp / (tp + fn) : 0;
        const F1 = P + R ? (2 * P * R) / (P + R) : 0;
        table.push({ name, kept, tp, fp, fn, P, R, F1 });
        console.log(
            `${name.padEnd(16)} findings ${String(kept).padStart(3)} | tp ${String(tp).padStart(2)} fp ${String(fp).padStart(3)} fn ${String(fn).padStart(2)} | R ${(R * 100).toFixed(1)}% P ${(P * 100).toFixed(1)}% F1 ${F1.toFixed(3)}`,
        );
    }

    fs.writeFileSync(
        path.join(__dirname, 'results', `offline-filter-ab-${path.basename(DUMP)}.json`),
        JSON.stringify({ dump: DUMP, model: MODEL, table }, null, 2),
    );
})();
