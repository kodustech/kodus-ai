// Dedup-eval driver. For each PR dataset (>=2 findings): judge-label findings →
// goldens (claude-haiku-4-5, cached), run the REAL dedup (gpt-5.4-mini) or a
// mock, score the over-merge / under-merge metrics, and print an aggregate.
//
//   node run.js                 # live dedup (needs OpenAI key)
//   node run.js --mock=identity # keep-all baseline (no Google; sanity/CI)
//   node run.js --limit=5       # first 5 dedup-relevant PRs
//   node run.js --pr=<caseId>   # one PR
//
// Keys: ANTHROPIC_API_KEY/BYOK_ANTHROPIC_API_KEY (judge) +
// BYOK_OPENAI_API_KEY/API_OPEN_AI_API_KEY (dedup default).
//
// The judge must stay a DIFFERENT model than the dedup (else the label→goldens
// step correlates with the merge decision). The dedup model is gpt-5.4-mini, so
// pin the judge to claude-haiku-4-5 (also the global default) BEFORE requiring
// recall-judge, which captures JUDGE_MODEL at load time — this stays correct
// even if the global default judge is later pointed at gpt-5.4-mini.
process.env.JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-haiku-4-5';
if (process.env.JUDGE_MODEL === 'gpt-5.4-mini') process.env.JUDGE_MODEL = 'claude-haiku-4-5';
const fs = require('fs');
const path = require('path');
const { loadJudgeKey } = require('../investigation/recall-judge');
const { matchFindingsToGoldens, computeMetrics } = require('./dedup-eval');

// Prefer local dedup/datasets; fall back to shared secondary smoke set so
// `--mock=identity --gate` works on a clean checkout.
const DATA = (() => {
    const local = path.join(__dirname, 'datasets');
    const shared = path.join(__dirname, '../secondary/datasets');
    if (fs.existsSync(local) && fs.readdirSync(local).some((f) => f.endsWith('.json'))) {
        return local;
    }
    return shared;
})();
const CACHE = path.join(__dirname, '.cache-goldenlabels');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

function mockDedup(mode, findings) {
    const n = findings.length;
    if (mode === 'overmerge') {
        // merge everything into finding 0 — worst case, to see the harm ceiling
        return { kept: [0], dropped: Array.from({ length: n - 1 }, (_, i) => ({ idx: i + 1, keptInto: 0 })) };
    }
    // identity: keep all (no dedup) — the safe baseline
    return { kept: Array.from({ length: n }, (_, i) => i), dropped: [] };
}

/** Offline/heuristic golden labels for mock modes (no LLM judge key). */
function heuristicLabels(findings, goldens) {
    return findings.map((f) => {
        const text = `${f.oneSentenceSummary || ''} ${f.suggestionContent || ''}`.toLowerCase();
        for (let gi = 0; gi < goldens.length; gi++) {
            const g = String(goldens[gi] || '').toLowerCase();
            // crude token overlap: share a distinctive 6+ char token
            const gTokens = g.match(/[a-z_][a-z0-9_.]{5,}/g) || [];
            if (gTokens.some((t) => text.includes(t))) return gi;
        }
        return -1;
    });
}

async function main() {
    if (!fs.existsSync(DATA)) {
        console.error(`dedup datasets missing: ${DATA}`);
        console.error('Build or commit evals/dedup/datasets before using dedup as a CI gate.');
        process.exit(2);
    }

    const mock = args.mock;
    const dedupModel = args.model || 'gpt-5.4-mini'; // production default
    const gate = !!args.gate;
    const goldensLostMax = args['goldens-lost-max'] != null ? Number(args['goldens-lost-max']) : 0;
    let runDedup = null;
    if (!mock) ({ runDedup } = require('./dedup-runner'));
    // Mock modes use heuristic labels so CI needs no judge key.
    const judgeKey = mock ? null : loadJudgeKey();
    fs.mkdirSync(CACHE, { recursive: true });

    let files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
    if (args.pr) files = files.filter((f) => f.replace(/\.json$/, '') === args.pr);

    const rows = [];
    let done = 0;
    for (const file of files) {
        const ds = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
        if ((ds.findings || []).length < 2) continue; // nothing to dedup
        if (args.limit && done >= +args.limit) break;

        // golden labels (cached — judging is the expensive part and is dedup-independent)
        const cacheFile = path.join(CACHE, (mock ? 'mock-' : '') + file);
        let labels;
        if (fs.existsSync(cacheFile) && !mock) {
            labels = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } else if (mock) {
            labels = heuristicLabels(ds.findings, ds.goldenComments || []);
        } else {
            labels = await matchFindingsToGoldens(ds.findings, ds.goldenComments, judgeKey);
            fs.writeFileSync(cacheFile, JSON.stringify(labels));
        }

        let dedup;
        try {
            dedup = mock ? mockDedup(mock, ds.findings) : await runDedup(ds.findings, dedupModel, { temperature: args.temp != null ? Number(args.temp) : undefined, guard: args.guard || undefined, tightRatio: args.tightratio != null ? Number(args.tightratio) : undefined, contentThresh: args.contentthresh != null ? Number(args.contentthresh) : undefined });
        } catch (e) {
            console.error(`  ${ds.prId.slice(0, 40)}: dedup ERROR ${e.message.slice(0, 60)}`);
            continue;
        }
        const m = computeMetrics(ds.findings.length, labels, dedup);
        rows.push({ pr: ds.prId, ...m });
        done++;
        console.log(`• ${ds.prId.slice(0, 46).padEnd(46)} find=${m.findings} kept=${m.kept} drop=${m.dropped} lost=${m.goldensLost} under=${m.underMergeDups}`);
    }

    // aggregate
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    console.log('\n════════ DEDUP EVAL ' + (mock ? `(mock=${mock})` : `(model=${dedupModel})`) + ` · ${rows.length} PRs ════════`);
    console.log(`findings in:        ${sum('findings')}`);
    console.log(`kept / dropped:     ${sum('kept')} / ${sum('dropped')}`);
    console.log(`recall before→after: ${sum('recallBefore')} → ${sum('recallAfter')} goldens`);
    console.log(`GOLDENS LOST (over-merge harm): ${sum('goldensLost')}   ← headline; should be 0`);
    console.log(`  bad merges (dropped a sole-cover finding): ${sum('badMerged')}`);
    console.log(`good dup merges:    ${sum('dupMergedOk')}`);
    console.log(`noise merges (less spam): ${sum('noiseMerged')}`);
    console.log(`under-merge (residual dups left): ${sum('underMergeDups')}`);
    const prsWithLoss = rows.filter((r) => r.goldensLost > 0);
    if (prsWithLoss.length) {
        console.log(`\n⚠️  ${prsWithLoss.length} PR(s) lost goldens to dedup:`);
        prsWithLoss.forEach((r) => console.log(`   ${r.pr.slice(0, 50)} (-${r.goldensLost})`));
    }
    fs.writeFileSync(path.join(__dirname, `result-${mock ? 'mock-' + mock : dedupModel}.json`), JSON.stringify(rows, null, 2));

    if (gate) {
        if (!rows.length) {
            console.error('\n❌ GATE FAILED: no dedup-relevant rows were evaluated');
            process.exit(2);
        }
        const lost = sum('goldensLost');
        if (lost > goldensLostMax) {
            console.error(`\n❌ GATE FAILED: goldensLost ${lost} > ${goldensLostMax}`);
            process.exit(1);
        }
        console.log(`\n✅ GATE PASSED (goldensLost ≤ ${goldensLostMax})`);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });
