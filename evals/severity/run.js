// Severity-eval driver.
//
//   node evals/severity/run.js --mock=heuristic     # CI: no LLM keys
//   node evals/severity/run.js --mock=all-medium
//   node evals/severity/run.js --mock=agent
//   node evals/severity/run.js --model=gpt-5.4-mini  # live (needs keys)
//   node evals/severity/run.js --gate --mock=heuristic
//
// Exit: 0 pass / 1 quality gate / 2 infra
const fs = require('fs');
const path = require('path');
const {
    computeMetrics,
    heuristicJudgeSeverity,
    normalizeSeverity,
} = require('./severity-eval');
const { SECONDARY_BASELINE } = require('../shared/secondary-models');

const DATA =
    process.env.SECONDARY_DATASETS ||
    path.join(__dirname, '../secondary/datasets');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

function loadDatasets() {
    if (!fs.existsSync(DATA)) {
        console.error(`severity datasets missing: ${DATA}`);
        process.exit(2);
    }
    let files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
    if (args.pr) {
        files = files.filter((f) => f.replace(/\.json$/, '') === args.pr);
    }
    const rows = [];
    for (const file of files) {
        const ds = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
        if (!(ds.findings || []).length) continue;
        rows.push(ds);
        if (args.limit && rows.length >= +args.limit) break;
    }
    return rows;
}

function mockClassify(mode, findings) {
    if (mode === 'all-medium') {
        return {
            labels: findings.map(() => 'medium'),
            parseOk: true,
            defaultedAll: false,
        };
    }
    if (mode === 'agent') {
        return {
            labels: findings.map((f) => normalizeSeverity(f.severity)),
            parseOk: true,
            defaultedAll: false,
        };
    }
    // heuristic: model labels = same as heuristic judge (perfect acc)
    if (mode === 'heuristic') {
        return {
            labels: findings.map(heuristicJudgeSeverity),
            parseOk: true,
            defaultedAll: false,
        };
    }
    throw new Error(`unknown mock mode '${mode}'`);
}

async function main() {
    const datasets = loadDatasets();
    const mock = args.mock;
    const modelKey = args.model || SECONDARY_BASELINE;
    const gate = !!args.gate;
    const falseDropMax =
        args['false-drop-max'] != null ? Number(args['false-drop-max']) : 0;
    const parseFailMax =
        args['parse-fail-max'] != null ? Number(args['parse-fail-max']) : 0;

    let runSeverity = null;
    if (!mock) {
        ({ runSeverity } = require('./severity-runner'));
    }

    const rows = [];
    for (const ds of datasets) {
        const judgeLabels = ds.findings.map(heuristicJudgeSeverity);
        let modelResult;
        try {
            modelResult = mock
                ? mockClassify(mock, ds.findings)
                : await runSeverity(ds.findings, modelKey);
        } catch (e) {
            console.error(
                `  ${ds.prId}: severity ERROR ${String(e.message || e).slice(0, 80)}`,
            );
            if (gate && !mock) process.exit(2);
            continue;
        }

        const m = computeMetrics(judgeLabels, modelResult.labels, {
            parseOk: modelResult.parseOk,
            defaultedAll: modelResult.defaultedAll,
        });
        rows.push({ pr: ds.prId, ...m });
        console.log(
            `• ${ds.prId.slice(0, 46).padEnd(46)} n=${m.n} exact=${m.exact}/${m.n} drop@high=${m.filter_false_drop_high} parse_fail=${m.parse_fail}`,
        );
    }

    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const totalN = sum('n') || 1;
    const exactAcc = sum('exact') / totalN;
    const mae =
        rows.reduce((a, r) => a + r.ordinal_mae * r.n, 0) / totalN;
    const falseDropHigh = sum('filter_false_drop_high');
    const parseFails = sum('parse_fail');

    console.log(
        `\n════════ SEVERITY EVAL ${mock ? `(mock=${mock})` : `(model=${modelKey})`} · ${rows.length} PRs ════════`,
    );
    console.log(`findings:              ${sum('n')}`);
    console.log(`exact_acc:             ${exactAcc.toFixed(3)}`);
    console.log(`ordinal_mae:           ${mae.toFixed(3)}`);
    console.log(
        `filter_false_drop@high: ${falseDropHigh}   ← headline; should be 0`,
    );
    console.log(`filter_false_drop@med: ${sum('filter_false_drop_medium')}`);
    console.log(`filter_false_keep@high:${sum('filter_false_keep_high')}`);
    console.log(`parse_fails (PRs):     ${parseFails}`);

    fs.writeFileSync(
        path.join(
            __dirname,
            `result-${mock ? 'mock-' + mock : modelKey.replace(/[^\w.-]+/g, '_')}.json`,
        ),
        JSON.stringify(rows, null, 2),
    );

    if (gate) {
        if (!rows.length) {
            console.error('\n❌ GATE FAILED: no rows evaluated');
            process.exit(2);
        }
        if (falseDropHigh > falseDropMax) {
            console.error(
                `\n❌ GATE FAILED: filter_false_drop@high ${falseDropHigh} > ${falseDropMax}`,
            );
            process.exit(1);
        }
        if (parseFails > parseFailMax) {
            console.error(
                `\n❌ GATE FAILED: parse_fails ${parseFails} > ${parseFailMax}`,
            );
            process.exit(1);
        }
        console.log(
            `\n✅ GATE PASSED (false_drop@high ≤ ${falseDropMax}, parse_fails ≤ ${parseFailMax})`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
