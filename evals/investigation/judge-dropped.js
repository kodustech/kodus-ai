#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
/**
 * Judges the candidates the reducer THREW AWAY against the goldens the run
 * reported as missed.
 *
 * Recall is computed on what gets posted, so a golden an agent found and the
 * reducer dropped costs exactly as much as one never found at all — and is
 * invisible in every metric the harness produces. Across 29 PRs the reducer
 * discards 45% of all candidates (136 of 301), and nothing has ever checked
 * what is in that 45%.
 *
 * Reuses the benchmark's own judge, so a match here means the same thing a
 * match means in the recall number.
 *
 * Usage:
 *   node evals/investigation/judge-dropped.js [--out=file.json]
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');

// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const DUMPS = ['m14', 'm14r', 'm14r8', 'quota1'];
const DATASETS = path.join(__dirname, 'datasets');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const OUT = arg('out', path.join(__dirname, 'results', 'dropped-judged.json'));

const K = (s) => String(s).replace(/«[^»]*»/g, '').slice(0, 55).trim();
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

/** Same identity the reducer's own output is keyed by: a candidate that shares
 *  file and summary with a posted finding survived; anything else was cut. */
const idOf = (f) =>
    `${String(f.relevantFile || '').slice(-50)}|${String(f.oneSentenceSummary || '').slice(0, 70).toLowerCase()}`;

const text = (f) =>
    [f.oneSentenceSummary, f.suggestionContent, f.existingCode]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1800);

(async () => {
    const goldens = {};
    for (const f of fs.readdirSync(DATASETS)) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'))[0].vars;
            if (v?.caseId) goldens[v.caseId] = J(v.goldenComments);
        } catch {}
    }
    // The run's own verdict on which goldens were missed.
    const missed = {};
    for (const rf of ['m14-run.json', 'm14-rest25.json', 'quota1.json', 'm14-rest8.json']) {
        const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', rf), 'utf8'));
        for (const r of j.rows) {
            if (r.status === 'infra') continue;
            const m = String(r.reason || '').match(/missed\[[^\]]*\]:\s*(.*)$/);
            missed[r.caseId] = new Set(m ? m[1].split(' | ').map(K) : []);
        }
    }

    const jobs = [];
    for (const d of DUMPS) {
        for (const f of fs.readdirSync(path.join(S, d)).filter((x) => x.endsWith('.raw.txt'))) {
            const j = JSON.parse(fs.readFileSync(path.join(S, d, f), 'utf8'));
            const cands = j.trace?.preFilterCandidates || [];
            if (!cands.length) continue;
            const kept = new Set((j.findings || []).map(idOf));
            const dropped = cands.filter((c) => !kept.has(idOf(c)));
            const miss = missed[j.caseId] || new Set();
            const alvos = (goldens[j.caseId] || []).filter((g) => miss.has(K(g.comment)));
            if (!dropped.length || !alvos.length) continue;
            for (const c of dropped) for (const g of alvos) jobs.push({ caseId: j.caseId, golden: g, cand: c });
        }
    }

    console.log(`${jobs.length} pares (candidato descartado × golden perdido) para julgar\n`);
    const key = loadJudgeKey();
    const hits = [];
    let done = 0;
    for (const job of jobs) {
        done++;
        if (done % 25 === 0) process.stdout.write(`  ${done}/${jobs.length}\n`);
        try {
            const v = await matchCommentDetailed(key, job.golden.comment, text(job.cand));
            if (v?.match && (v.confidence ?? 0) >= 0.5) {
                hits.push({
                    caseId: job.caseId,
                    severity: job.golden.severity,
                    golden: job.golden.comment,
                    candidate: job.cand.oneSentenceSummary,
                    file: job.cand.relevantFile,
                    producedBy: job.cand.producedBy,
                    confidence: v.confidence,
                });
            }
        } catch (err) {
            // A judge failure is not a non-match; say so rather than count it as one.
            console.log(`  ERRO ${job.caseId.slice(0, 30)}: ${String(err.message || err).slice(0, 80)}`);
        }
    }
    const unicos = new Map();
    for (const h of hits) unicos.set(`${h.caseId}|${K(h.golden)}`, h);
    fs.writeFileSync(OUT, JSON.stringify({ pares: jobs.length, hits, unicos: [...unicos.values()] }, null, 2));
    console.log(`\n${unicos.size} GOLDENS achados pelos agentes e descartados pelo redutor`);
    for (const h of unicos.values()) {
        console.log(`\n  [${h.severity}] ${h.caseId.slice(0, 44)}`);
        console.log(`     golden   : ${String(h.golden).replace(/\s+/g, ' ').slice(0, 110)}`);
        console.log(`     descartado: ${String(h.candidate).replace(/\s+/g, ' ').slice(0, 110)}  (${h.producedBy || '?'})`);
    }
    console.log(`\n-> ${OUT}`);
})();
