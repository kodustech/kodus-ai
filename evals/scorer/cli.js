#!/usr/bin/env node
/**
 * CLI do scorer — pontua uma submission contra os goldens do dataset.
 *
 *   node evals/scorer/cli.js --submission=sub.json [--out=scorecard.json]
 *   node evals/scorer/cli.js --submission=sub.json --validate    # só valida o schema
 *
 * Judge: --judge=<model> ou JUDGE_MODEL (default claude-haiku-4-5).
 * A chave sai do provider do judge (API_ANTHROPIC_API_KEY, etc), via recall-judge.
 *
 * Este comando NÃO chama modelo de review. Re-pontuar 30 casos custa centavos —
 * é o que permite trocar de judge, ou rodar um painel multi-judge, sem repetir a
 * passada cara do harness.
 */
const fs = require('fs');
const path = require('path');
const { scoreSubmission } = require('./score');
const { loadKeyForModel } = require('../investigation/recall-judge');
const { validateSubmission } = require('./validate');

const DATASETS_DIR = path.join(__dirname, '..', 'investigation', 'datasets');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

/** caseId -> { goldens, corpus } a partir dos datasets versionados. */
function loadDataset() {
    const map = new Map();
    for (const file of fs.readdirSync(DATASETS_DIR)) {
        if (!file.endsWith('.json') || file === 'smoke.json') continue;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(DATASETS_DIR, file), 'utf8'));
        } catch {
            continue; // dataset corrompido não derruba o scorer
        }
        for (const t of Array.isArray(parsed) ? parsed : [parsed]) {
            const v = (t && t.vars) || {};
            if (!v.caseId) continue;
            let goldens = [];
            try {
                goldens = JSON.parse(v.goldenComments || '[]');
            } catch {
                goldens = [];
            }
            let corpus = '';
            try {
                const replay = JSON.parse(v.toolReplay || '{}');
                corpus = (replay.readFile || []).map((e) => String(e.result || '')).join('\n');
            } catch {
                corpus = '';
            }
            map.set(v.caseId, { goldens, corpus });
        }
    }
    return map;
}

function pct(x) {
    return x == null ? ' n/a' : `${(x * 100).toFixed(1)}%`;
}

async function main() {
    if (!args.submission) {
        console.error('uso: node evals/scorer/cli.js --submission=<arquivo.json> [--out=<scorecard.json>] [--judge=<modelo>] [--validate]');
        process.exit(2);
    }

    const submission = JSON.parse(fs.readFileSync(args.submission, 'utf8'));

    const problems = validateSubmission(submission);
    if (problems.length) {
        console.error(`❌ submission inválida (${problems.length} problema(s)):`);
        for (const p of problems) console.error(`   - ${p}`);
        process.exit(1);
    }
    console.log('✅ schema da submission ok');
    if (args.validate) return;

    const dataset = loadDataset();
    const unknown = (submission.results || [])
        .map((r) => r.caseId)
        .filter((id) => !dataset.has(id));
    if (unknown.length) {
        console.error(`❌ caseIds não encontrados no dataset (${unknown.length}): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}`);
        process.exit(1);
    }

    const judgeModel = args.judge || process.env.JUDGE_MODEL || 'claude-haiku-4-5';
    const apiKey = loadKeyForModel(judgeModel);
    if (!apiKey) {
        console.error(`❌ sem chave para o judge '${judgeModel}' — configure no env ou em ~/.kodus-dev/config`);
        process.exit(2);
    }

    const { harness, model, executionMode, accessPath } = submission.run || {};
    console.log(
        `\n════ scoring · harness=${harness?.name || '?'} · model=${model?.id || 'bundled'} · ` +
            `mode=${executionMode} · access=${model?.accessPath || accessPath || 'n/a'} · judge=${judgeModel} ════\n`,
    );

    const scorecard = await scoreSubmission({
        submission,
        dataset,
        judge: { model: judgeModel, apiKey },
        concurrency: Number(args.concurrency) || 6,
        onProgress: (row, i, total) => {
            const m = row.metrics;
            console.log(
                `[${String(i).padStart(2)}/${total}] ${row.caseId.slice(0, 52).padEnd(52)} ` +
                    (m
                        ? `recall ${String(m.matched).padStart(2)}/${String(m.goldens).padEnd(2)} ` +
                          `prec ${pct(m.precision)} F1 ${m.f1.toFixed(2)}`
                        : row.status),
            );
        },
    });

    const a = scorecard.aggregate;
    console.log(`\n════ ${harness?.name || '?'} / ${model?.id || 'bundled'} ════`);
    console.log(`  recall (micro, pondera por golden) : ${pct(a.recallMicro)}  [${a.goldensMatched}/${a.goldensTotal}]`);
    console.log(`  recall (macro, média por caso)     : ${pct(a.recallMacro)}`);
    console.log(`  precision (macro)                  : ${pct(a.precisionMacro)}`);
    console.log(`  F1 (macro)                         : ${pct(a.f1Macro)}`);
    console.log(`  fair-recall (macro)                : ${pct(a.fairRecallMacro)}`);
    console.log(`  loop-fidelity (macro)              : ${pct(a.loopFidelityMacro)}`);
    console.log(`  casos                              : ${a.casesScored}/${a.cases}`);
    if (a.usage.inputTokens || a.usage.outputTokens) {
        console.log(`  tokens                             : ${a.usage.inputTokens.toLocaleString()} in / ${a.usage.outputTokens.toLocaleString()} out`);
    }

    const out =
        args.out ||
        path.join(
            __dirname,
            '..',
            'investigation',
            'results',
            `scorecard-${harness?.name || 'unknown'}-${(model?.id || 'bundled').replace(/[^\w.-]/g, '_')}.json`,
        );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(scorecard, null, 2));
    console.log(`\nscorecard → ${out}`);
}

main().catch((e) => {
    console.error('erro:', e && e.message ? e.message : e);
    process.exit(2);
});
