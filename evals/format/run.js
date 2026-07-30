// Format-eval driver.
//
//   node evals/format/run.js --mock=identity   # keep original (expect scaffold fails)
//   node evals/format/run.js --mock=perfect    # synthetic clean prose (CI gate)
//   node evals/format/run.js --model=gpt-5.4-mini
//   node evals/format/run.js --gate --mock=perfect
//
// Exit: 0 pass / 1 quality gate / 2 infra
const fs = require('fs');
const path = require('path');
const { computeMetrics } = require('./format-eval');
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
        console.error(`format datasets missing: ${DATA}`);
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

/** Strip WHAT/WHY/HOW labels for the "perfect" mock. */
function stripScaffold(text) {
    return String(text || '')
        .replace(/\bWHAT\s*:\s*/gi, '')
        .replace(/\bWHY\s*:\s*/gi, '')
        .replace(/\bHOW\s*:\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function mockFormat(mode, findings) {
    if (mode === 'identity') {
        const formatted = new Map();
        findings.forEach((f, i) => {
            formatted.set(i, {
                suggestionContent: f.suggestionContent || '',
                improvedCode: f.improvedCode || '',
            });
        });
        return { formatted, parseOk: true };
    }
    if (mode === 'perfect') {
        const formatted = new Map();
        findings.forEach((f, i) => {
            formatted.set(i, {
                suggestionContent: stripScaffold(f.suggestionContent),
                improvedCode: f.improvedCode || '',
            });
        });
        return { formatted, parseOk: true };
    }
    if (mode === 'empty') {
        return { formatted: new Map(), parseOk: false };
    }
    throw new Error(`unknown mock mode '${mode}'`);
}

async function main() {
    const datasets = loadDatasets();
    const mock = args.mock;
    const modelKey = args.model || SECONDARY_BASELINE;
    const gate = !!args.gate;
    const identMin =
        args['ident-min'] != null ? Number(args['ident-min']) : 0.5;
    const parseFailMax =
        args['parse-fail-max'] != null ? Number(args['parse-fail-max']) : 0;
    // perfect mock should auto-pass; identity intentionally fails scaffold
    const autoPassMin =
        args['auto-pass-min'] != null
            ? Number(args['auto-pass-min'])
            : mock === 'identity'
              ? 0
              : 0.7;

    let runFormat = null;
    if (!mock) {
        ({ runFormat } = require('./format-runner'));
    }

    const rows = [];
    for (const ds of datasets) {
        let result;
        try {
            result = mock
                ? mockFormat(mock, ds.findings)
                : await runFormat(ds.findings, modelKey);
        } catch (e) {
            console.error(
                `  ${ds.prId}: format ERROR ${String(e.message || e).slice(0, 80)}`,
            );
            if (gate && !mock) process.exit(2);
            continue;
        }

        const m = computeMetrics(ds.findings, result.formatted, {
            parseOk: result.parseOk,
        });
        rows.push({ pr: ds.prId, ...m });
        console.log(
            `• ${ds.prId.slice(0, 46).padEnd(46)} n=${m.n} auto=${m.auto_pass}/${m.n} idents=${m.ident_recall_mean.toFixed(2)} parse_fail=${m.parse_fail}`,
        );
    }

    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const totalN = sum('n') || 1;
    const autoPassRate = sum('auto_pass') / totalN;
    const identMean =
        rows.reduce((a, r) => a + r.ident_recall_mean * r.n, 0) / totalN;
    const parseFails = sum('parse_fail');

    console.log(
        `\n════════ FORMAT EVAL ${mock ? `(mock=${mock})` : `(model=${modelKey})`} · ${rows.length} PRs ════════`,
    );
    console.log(`findings:           ${sum('n')}`);
    console.log(`auto_pass_rate:     ${autoPassRate.toFixed(3)}`);
    console.log(`ident_recall_mean:  ${identMean.toFixed(3)}`);
    console.log(`no_scaffold_rate:   ${(sum('no_scaffold_rate') / (rows.length || 1)).toFixed(3)} (avg of PR rates)`);
    console.log(`parse_fails (PRs):  ${parseFails}`);

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
        if (parseFails > parseFailMax) {
            console.error(
                `\n❌ GATE FAILED: parse_fails ${parseFails} > ${parseFailMax}`,
            );
            process.exit(1);
        }
        if (identMean < identMin) {
            console.error(
                `\n❌ GATE FAILED: ident_recall_mean ${identMean.toFixed(3)} < ${identMin}`,
            );
            process.exit(1);
        }
        if (autoPassRate < autoPassMin) {
            console.error(
                `\n❌ GATE FAILED: auto_pass_rate ${autoPassRate.toFixed(3)} < ${autoPassMin}`,
            );
            process.exit(1);
        }
        console.log(
            `\n✅ GATE PASSED (idents ≥ ${identMin}, auto_pass ≥ ${autoPassMin}, parse_fails ≤ ${parseFailMax})`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
