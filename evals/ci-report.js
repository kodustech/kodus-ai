#!/usr/bin/env node
// Turns eval results into what a human reads: the Actions job summary and the
// Discord message. Reads result files only — it never runs an eval.
//
//   node evals/ci-report.js nightly <finder-recall result.json>
//   node evals/ci-report.js tier0 <dir with tier0-smoke-*.json>
//
// Writes markdown to $GITHUB_STEP_SUMMARY and `status`, `title`, `description`
// to $GITHUB_OUTPUT when those are set; prints the markdown otherwise.
const fs = require('fs');
const path = require('path');

function pct(value) {
    return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a';
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function runUrl(env) {
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
    return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null;
}

function emit({ status, title, description, markdown }) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    else console.log(markdown);
    if (process.env.GITHUB_OUTPUT) {
        const delimiter = `EOF_${Date.now()}`;
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `status=${status}\ntitle=${title}\ndescription<<${delimiter}\n${description}\n${delimiter}\n`,
        );
    }
    console.log(`\n${title}\n${description}`);
}

// result: the finder-recall summary JSON (null when the run never wrote one).
function nightlyReport(result, env = {}) {
    const url = runUrl(env);
    const { EVAL_BASE_SHA: base, GITHUB_SHA: head, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;
    const compare = base && head && base !== head ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}` : null;

    if (!result) {
        return {
            status: 'failure',
            title: '❌ Nightly eval produced no result',
            description: ['The finder-recall run crashed before writing its result — nothing was measured.', url && `Run: ${url}`].filter(Boolean).join('\n'),
            markdown: '## Nightly eval\n\nNo result file — the run crashed before measuring. See the log above.',
        };
    }

    const m = result.metrics || {};
    const gate = result.gate || {};
    const check = (name) => (gate.checks || []).find((c) => c.name === name);
    const recallCheck = check('recall_mean');
    const observed = gate.observed || {};
    const infra = result.infraFailures || 0;

    let status = 'success';
    let headline = '✅ Nightly eval: quality holds';
    if (infra > 0) {
        status = 'failure';
        headline = `⚠️ Nightly eval: ${infra}/${result.cases} PRs not measured (infra)`;
    } else if (gate.status === 'fail') {
        status = 'failure';
        headline = '❌ Nightly eval: review quality dropped below the floor';
    } else if (gate.status !== 'pass') {
        status = 'failure';
        headline = `⚠️ Nightly eval: not gated (${gate.reason || gate.status})`;
    }

    const failed = (gate.checks || []).filter((c) => !c.pass).map((c) => `${c.name} ${typeof c.actual === 'number' ? c.actual.toFixed(2) : 'n/a'} < ${c.floor}`);
    const infraReasons = [...new Set((result.rows || []).filter((r) => r.status === 'infra').map((r) => String(r.reason || '').slice(0, 140)))].slice(0, 3);

    const description = [
        `${result.model} · ${result.cases} PRs · recall ${pct(m.recall_mean)}${recallCheck ? ` (floor ${pct(recallCheck.floor)}${observed.recall_mean ? `, calibrated ${pct(observed.recall_mean)}` : ''})` : ''} · precision ${pct(m.precision_mean)}`,
        failed.length ? `Below floor: ${failed.join('; ')}` : null,
        infraReasons.length ? `Infra: ${infraReasons.join(' | ')}` : null,
        compare ? `Engine changes measured: ${compare}` : null,
        url ? `Run: ${url}` : null,
    ].filter(Boolean).join('\n');

    const rows = (result.rows || [])
        .map((r) => {
            const md = r.metadata || {};
            const findings = typeof md.tpFindings === 'number' ? md.tpFindings + md.fpFindings : 'n/a';
            return `| ${r.caseId} | ${r.status} | ${pct(md.recall)} | ${pct(md.precision)} | ${findings} | ${md.totalCalls ?? 'n/a'} |`;
        })
        .join('\n');
    const markdown = [
        `## ${headline}`,
        '',
        description.replace(/\n/g, '  \n'),
        '',
        '| check | actual | floor | result |',
        '| --- | --- | --- | --- |',
        ...(gate.checks || []).map((c) => `| ${c.name} | ${typeof c.actual === 'number' ? c.actual.toFixed(3) : 'n/a'} | ${c.floor} | ${c.pass ? 'ok' : '**below**'} |`),
        '',
        '<details><summary>Per PR</summary>',
        '',
        '| case | status | recall | precision | findings | tool calls |',
        '| --- | --- | --- | --- | --- | --- |',
        rows,
        '',
        '</details>',
    ].join('\n');

    return { status, title: headline, description, markdown };
}

// results: one tier0-smoke JSON per requested model; a model without one is
// reported as missing (its job crashed or timed out).
function tier0Report(models, readResult, env = {}) {
    const url = runUrl(env);
    const icon = { pass: '✅', broken: '❌', infra: '⚠️', skipped: '➖', missing: '❓' };
    const results = models.map(
        (model) => readResult(model) || { model, status: 'missing', reason: 'no result — the job crashed or timed out', prSummary: { status: 'missing' } },
    );

    const worst = (r) => [r.status, r.prSummary?.status];
    const broken = results.filter((r) => worst(r).some((s) => s === 'broken' || s === 'missing'));
    const infra = results.filter((r) => !broken.includes(r) && worst(r).includes('infra'));

    let status = 'success';
    let headline = `✅ Tier-0 smoke: all ${results.length} models review`;
    if (broken.length) {
        status = 'failure';
        headline = `❌ Tier-0 smoke: ${broken.map((r) => r.model).join(', ')} no longer review${broken.length === 1 ? 's' : ''}`;
    } else if (infra.length) {
        status = 'failure';
        headline = `⚠️ Tier-0 smoke: could not reach ${infra.map((r) => r.model).join(', ')} (key/quota/network)`;
    }

    const line = (r) =>
        `${icon[r.status]} ${r.model} — review ${r.status}${r.status === 'pass' ? ` (${r.toolCalls} tool calls, ${r.findings} findings, ${r.seconds}s)` : `: ${String(r.reason || '').slice(0, 160)}`} · summary ${icon[r.prSummary?.status] || '❓'}${r.prSummary?.reason ? ` ${String(r.prSummary.reason).slice(0, 120)}` : ''}`;
    const description = [...results.map(line), url ? `Run: ${url}` : null].filter(Boolean).join('\n');
    const markdown = [`## ${headline}`, '', ...results.map((r) => `- ${line(r)}`)].join('\n');

    return { status, title: headline, description, markdown };
}

module.exports = { nightlyReport, tier0Report };

if (require.main === module) {
    const [mode, target] = process.argv.slice(2);
    if (mode === 'nightly' && target) {
        emit(nightlyReport(readJson(target), process.env));
    } else if (mode === 'tier0' && target) {
        // EVAL_MODELS: the models this run was asked for (a dispatch can pin one).
        const models = process.env.EVAL_MODELS ? JSON.parse(process.env.EVAL_MODELS) : require('./shared/tier0-models').tier0();
        const readResult = (model) => readJson(path.join(target, `tier0-smoke-${model.replace(/[^\w.-]+/g, '-')}.json`));
        emit(tier0Report(models, readResult, process.env));
    } else {
        console.error('usage: node evals/ci-report.js nightly <result.json> | tier0 <dir>');
        process.exit(2);
    }
}
