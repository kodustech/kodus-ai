#!/usr/bin/env node
/**
 * Writes a previous run's posted findings into each dataset as `priorFindings`,
 * so a later pass can be told what has already been found.
 *
 * Measured reason: the simulation pass found 21 goldens and 19 of them were
 * already found by the fifteen class agents — 90% of its true positives were
 * re-discovery. Its 6.5M tokens are cheap, but nine tenths of them went to
 * ground that was already covered.
 *
 * Goes through the dataset rather than an env var because the payload is
 * per-case, and because a knob that carries a path would make the corpus and
 * the run silently coupled — a dataset that says what it holds is greppable.
 *
 * Usage:
 *   node evals/investigation/inject-prior-findings.js --dump=<dir> [--set=light]
 *   node evals/investigation/inject-prior-findings.js --clear
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const DUMP = arg('dump');
const CLEAR = process.argv.includes('--clear');
const POSTED = process.argv.includes('--posted');
const DATASETS = path.join(__dirname, 'datasets');

if (!DUMP && !CLEAR) {
    console.error('need --dump=<dir> (or --clear)');
    process.exit(1);
}

const byCase = {};
if (DUMP) {
    for (const f of fs.readdirSync(DUMP).filter((x) => x.endsWith('.raw.txt'))) {
        try {
            const j = JSON.parse(fs.readFileSync(path.join(DUMP, f), 'utf8'));
            // The PRE-REDUCER candidates, not the posted findings. The
            // reducer runs once, at the end, over everything — so at the
            // moment a later pass executes, nothing has been filtered yet.
            // Handing it the posted set would describe a state that never
            // exists in production. `--posted` restores the other behaviour
            // for an A/B.
            const src = POSTED
                ? j.findings || []
                : j.trace?.preFilterCandidates || j.findings || [];
            byCase[j.caseId] = src.map((x) => ({
                file: x.relevantFile,
                line: x.relevantLinesStart,
                summary: x.oneSentenceSummary,
            }));
        } catch {}
    }
}

let n = 0;
for (const file of fs.readdirSync(DATASETS)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(DATASETS, file);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const vars = rec[0]?.vars;
    if (!vars?.caseId) continue;

    if (CLEAR) {
        if (vars.priorFindings === undefined) continue;
        delete vars.priorFindings;
    } else {
        const f = byCase[vars.caseId];
        if (!f) continue;
        vars.priorFindings = JSON.stringify(f);
    }
    fs.writeFileSync(full, `${JSON.stringify(rec, null, 2)}\n`);
    n++;
    if (!CLEAR) console.log(`${vars.caseId.slice(0, 52).padEnd(54)} ${byCase[vars.caseId].length} achados anteriores`);
}
console.log(`\n${n} datasets ${CLEAR ? 'limpos' : 'atualizados'}`);
