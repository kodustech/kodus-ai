#!/usr/bin/env node
// Re-scores saved finder-recall runs with the current judge, without running the
// finder again. For changing judges: the finder is the expensive part (~$3.5 a
// night), the judge costs cents, and floors must be recalibrated under the judge
// that will gate — so re-judge the calibration runs' findings instead of paying
// for new ones.
//
//   JUDGE_MODEL=<id> [JUDGE_REASONING_EFFORT=low] node evals/investigation/rejudge.js \
//       <nightly.json> <nightly.submission.json> --out=<result.json> [--concurrency=6]
//
// The output has run-recall's shape (rows with recall, precision, goldenResults),
// so paired calibration and nightly-compare read it as-is. Scoring goes through
// the same recall-assertion the nightly uses; a finding's judged text is rebuilt
// exactly (summary — content — label — file).
const fs = require('fs');
const path = require('path');
const recallAssertion = require('./recall-assertion');
const { avg } = require('./gate');

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function datasetVars() {
    const dir = path.join(__dirname, 'datasets');
    const vars = new Map();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        try {
            const raw = readJson(path.join(dir, file));
            const c = Array.isArray(raw) ? raw[0] : raw;
            if (c?.vars?.caseId) vars.set(c.vars.caseId, c.vars);
        } catch {
            /* unreadable dataset: not one of ours */
        }
    }
    return vars;
}

// Submission findings keep summary+content joined in `description`; label and
// file come back as the extra fields recall-assertion appends. The trace isn't
// re-derived: scoring doesn't read it, and the fidelity fields are copied from
// the source row (FIDELITY).
function agentOutputOf(result) {
    return JSON.stringify({
        findings: (result.findings || []).map((f) => ({ oneSentenceSummary: f.description, label: f.category, relevantFile: f.path })),
    });
}

const FIDELITY = ['totalCalls', 'hitRate', 'unserved'];

async function main() {
    const [summaryFile, submissionFile] = process.argv.slice(2);
    const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
    const concurrencyFlag = (process.argv.find((a) => a.startsWith('--concurrency=')) || '--concurrency=6').slice(14);
    const concurrency = /^\d+$/.test(concurrencyFlag) ? Number(concurrencyFlag) : 0;
    if (!summaryFile || !submissionFile || !out || concurrency < 1) {
        console.error('usage: node evals/investigation/rejudge.js <nightly.json> <nightly.submission.json> --out=<result.json> [--concurrency=<positive integer>]');
        return 2;
    }
    const original = readJson(summaryFile);
    const submission = new Map(readJson(submissionFile).results.map((r) => [r.caseId, r]));
    const vars = datasetVars();
    // PRs the source run couldn't measure stay unmeasured here, so the output
    // describes the same 30 PRs as the run it re-scores.
    const rows = (original.rows || []).filter((row) => row.status === 'infra').map((row) => ({ caseId: row.caseId, status: 'infra', reason: `infra in the source run: ${row.reason || 'unknown'}` }));
    let infraFailures = rows.length;
    const queue = (original.rows || []).filter((row) => row.status !== 'infra');
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const row = queue[cursor++];
            if (!row) return;
            const caseVars = vars.get(row.caseId);
            const result = submission.get(row.caseId);
            if (!caseVars || !result) {
                infraFailures += 1;
                rows.push({ caseId: row.caseId, status: 'infra', reason: 'case missing from datasets or submission' });
                continue;
            }
            try {
                const assertion = await recallAssertion(agentOutputOf(result), { vars: caseVars });
                const fidelity = Object.fromEntries(FIDELITY.map((key) => [key, row.metadata?.[key] ?? null]));
                rows.push({ caseId: row.caseId, status: assertion.pass ? 'pass' : 'fail', score: assertion.score, metadata: { ...assertion.metadata, ...fidelity }, judgedBefore: row.metadata?.recall ?? null });
            } catch (error) {
                infraFailures += 1;
                rows.push({ caseId: row.caseId, status: 'infra', reason: error.message });
                console.log(`INFRA ${row.caseId} ${error.message.slice(0, 200)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const order = new Map((original.rows || []).map((r, i) => [r.caseId, i]));
    rows.sort((a, b) => order.get(a.caseId) - order.get(b.caseId));

    const measured = rows.filter((r) => r.metadata);
    const summary = {
        model: original.model,
        judge: { model: process.env.JUDGE_MODEL || null, reasoningEffort: process.env.JUDGE_REASONING_EFFORT || null },
        rejudgedFrom: path.basename(summaryFile),
        startedAt: original.startedAt,
        finishedAt: original.finishedAt,
        tokens: original.tokens,
        cases: rows.length,
        infraFailures,
        metrics: {
            recall_mean: avg(measured.map((r) => r.metadata.recall)),
            precision_mean: avg(measured.map((r) => r.metadata.precision)),
            recall_mean_previous_judge: avg(measured.map((r) => r.judgedBefore)),
        },
        rows,
    };
    fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    const p = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a');
    console.log(`${path.basename(summaryFile)}: recall ${p(summary.metrics.recall_mean)} under ${summary.judge.model}${summary.judge.reasoningEffort ? ` (${summary.judge.reasoningEffort})` : ''} · ${p(summary.metrics.recall_mean_previous_judge)} under the previous judge · infra ${infraFailures}`);
    return infraFailures ? 2 : 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
