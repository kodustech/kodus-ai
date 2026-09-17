#!/usr/bin/env node
// Turns eval results into what a human reads: the Actions job summary and the
// Discord message. Reads result files only — it never runs an eval.
//
//   node evals/ci-report.js nightly <result.json> [--last-green=<result.json>]
//        [--commits=<tsv: sha, subject, author>] [--investigation=<json>]
//   node evals/ci-report.js tier0 <dir> [--previous=<dir>]
//
// Writes markdown to $GITHUB_STEP_SUMMARY and `status`, `verdict`, `title`,
// `description` to $GITHUB_OUTPUT when those are set; prints them otherwise.
//
// Messages are in Portuguese: they go to the team's channel. Facts come first;
// the LLM's reading, when there is one, is marked as a hypothesis and never
// changes the verdict.
const fs = require('fs');
const path = require('path');
const { compareNights, nightNoise, costUpperBound, catalogIdFor } = require('./investigation/nightly-compare');

const MAX_DROPS = 3;
const MAX_COMMITS = 4;

function pct(value) {
    return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/d';
}

function points(delta) {
    const n = Math.round(Math.abs(delta) * 100);
    return `${n} ${n === 1 ? 'ponto' : 'pontos'}`;
}

function clip(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

function minutesBetween(start, end) {
    const ms = Date.parse(end) - Date.parse(start);
    return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 60000)) : null;
}

function emit({ status, verdict, title, description, markdown }) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    else console.log(markdown);
    if (process.env.GITHUB_OUTPUT) {
        const delimiter = `EOF_${Date.now()}`;
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `status=${status}\nverdict=${verdict}\ntitle=${title}\ndescription<<${delimiter}\n${description}\n${delimiter}\n`,
        );
    }
    console.log(`\n${title}\n${description}`);
}

// ── nightly ──────────────────────────────────────────────────────────────────

// What the gate says, in order of what matters: a run that measured nothing is
// not a quality result; a collapse (no findings, no tool calls) is the engine
// breaking, not recall wobbling.
function nightlyVerdict(result, comparison, noise) {
    if (!result) return { verdict: 'infra', title: 'não produziu resultado' };
    if (result.error) return { verdict: 'infra', title: 'não mediu' };
    const infra = result.infraFailures || 0;
    if (infra > 0) return { verdict: 'infra', title: `${infra} de ${result.cases} PRs não medidos` };

    const gate = result.gate || {};
    const failed = (gate.checks || []).filter((check) => !check.pass).map((check) => check.name);
    if (gate.status === 'fail') {
        if (failed.includes('mean_tool_calls')) return { verdict: 'regression', title: 'o finder parou de usar as ferramentas' };
        if (failed.includes('mean_findings')) return { verdict: 'regression', title: 'o finder parou de produzir findings' };
        const delta = comparison?.recallDelta;
        return {
            verdict: 'regression',
            title: typeof delta === 'number' && delta < 0 ? `recall caiu ${points(delta)}, abaixo do piso` : 'recall abaixo do piso',
        };
    }
    if (gate.status !== 'pass') return { verdict: 'ungated', title: 'não comparou com o piso' };

    const delta = comparison?.recallDelta;
    if (typeof delta === 'number' && noise && delta >= 2 * noise) return { verdict: 'improved', title: `recall subiu ${points(delta)}` };
    return { verdict: 'pass', title: 'qualidade estável' };
}

const ICON = { pass: '✅', improved: '📈', regression: '❌', infra: '⚠️', ungated: '⚠️' };

function nightlyReport(result, env = {}, extras = {}) {
    const { lastGreen = null, commits = [], investigation = null, targets = null } = extras;
    const url = runUrl(env);
    const { EVAL_BASE_SHA: base, GITHUB_SHA: head, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;
    const compareUrl = base && head && base !== head ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}` : null;

    const comparison = result && lastGreen && !result.error ? compareNights(result, lastGreen) : null;
    const noise = targets && result ? nightNoise(targets, 'light', result.model) : null;
    const { verdict, title: headline } = nightlyVerdict(result, comparison, noise);
    const title = `${ICON[verdict]} Evals noturnos: ${headline}`;
    const status = verdict === 'pass' || verdict === 'improved' ? 'success' : 'failure';
    const lines = [];

    if (!result || result.error) {
        lines.push(result?.error ? `Motivo: ${clip(result.error, 300)}` : 'O finder-recall parou antes de gravar o resultado.');
        lines.push('', '**Próximo passo:** corrigir a chave ou a cota citada. A próxima noite mede de novo (noite sem medição nunca vira referência).');
    } else {
        const gate = result.gate || {};
        const floor = (gate.checks || []).find((check) => check.name === 'recall_mean')?.floor;
        const infra = result.infraFailures || 0;

        const measured = result.cases - infra;
        const context = [
            comparison?.recallBefore != null ? `última noite verde ${pct(comparison.recallBefore)}` : null,
            typeof floor === 'number' ? `piso ${pct(floor)}` : null,
        ].filter(Boolean).join(' · ');
        if (measured > 0) {
            lines.push(
                `Recall **${pct(result.metrics?.recall_mean)}**${context ? ` (${context})` : ''} · precisão ${pct(result.metrics?.precision_mean)}${comparison?.precisionBefore != null ? ` (antes ${pct(comparison.precisionBefore)})` : ''}`,
            );
        }
        const minutes = minutesBetween(result.startedAt, result.finishedAt);
        const cost = costUpperBound(result.tokens, catalogIdFor(result.model));
        lines.push(
            [`${measured}/${result.cases} PRs`, minutes ? `${minutes} min` : null, typeof cost === 'number' ? `≤ US$ ${cost.toFixed(2).replace('.', ',')}` : null]
                .filter(Boolean)
                .join(' · '),
        );

        if (infra > 0) {
            const reasons = [...new Set((result.rows || []).filter((row) => row.status === 'infra').map((row) => clip(row.reason, 160)))].slice(0, 2);
            lines.push('', `Motivo: ${reasons.join(' | ')}`);
        }

        if (comparison && (verdict === 'regression' || verdict === 'improved')) {
            const moved = verdict === 'improved' ? [...comparison.perCase].reverse() : comparison.perCase;
            const notable = moved.filter((c) => (verdict === 'improved' ? c.delta > 0 : c.delta < 0)).slice(0, MAX_DROPS);
            if (notable.length) {
                lines.push('', '**Onde mais mudou** (um PR sozinho oscila muito; o sinal é o agregado)');
                for (const c of notable) {
                    const bugs = verdict === 'improved' ? c.gained : c.lost;
                    const bugText = bugs && bugs.length ? `: ${verdict === 'improved' ? 'passou a achar' : 'deixou de achar'} "${clip(bugs[0], 90)}"${bugs.length > 1 ? ` e mais ${bugs.length - 1}` : ''}` : '';
                    lines.push(`• ${clip(c.caseId, 60)} ${pct(c.recallBefore)} → ${pct(c.recall)}${bugText}`);
                }
            }
            if (comparison.lostTotal !== null) lines.push(`Bugs perdidos: ${comparison.lostTotal} · novos achados: ${comparison.gainedTotal}`);
        }

        if (commits.length) {
            const shown = verdict === 'pass' ? [] : commits.slice(0, MAX_COMMITS);
            lines.push('', `**Mudanças medidas:** ${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} na engine desde a última noite verde`);
            for (const c of shown) lines.push(`• \`${c.sha}\` ${clip(c.subject, 80)} (${c.author})`);
            const rest = commits.length - shown.length;
            const tail = [shown.length && rest > 0 ? `+${rest}` : null, compareUrl ? `diff: ${compareUrl}` : null].filter(Boolean).join(' · ');
            if (tail) lines.push(tail);
        }

        if (investigation && verdict === 'regression') {
            const reading = { regression: 'provável regressão', noise: 'provavelmente ruído', eval: 'provável problema do próprio eval', unclear: 'inconclusivo' }[investigation.verdict] || 'hipótese';
            lines.push('', `**🤖 Leitura do Claude: ${reading}** (confiança ${investigation.confidence || 'n/d'}, não verificada)`);
            lines.push(clip(investigation.summary, 500));
            for (const suspect of (investigation.suspects || []).slice(0, 2)) {
                lines.push(`• ${[suspect.commit && `\`${suspect.commit}\``, suspect.file && `\`${suspect.file}\``].filter(Boolean).join(' ')} ${clip(suspect.why, 160)}`);
            }
            if (investigation.confirm) lines.push(`Pra confirmar: ${clip(investigation.confirm, 200)}`);
        }

        const next = {
            regression: 'rodar `pnpm eval:nightly` no commit anterior e no suspeito. Se a queda for intencional, recalibrar `sets.light` em `evals/investigation/targets.json` no mesmo PR.',
            improved: 'se a melhora se repetir na próxima noite, subir o piso (regra no `__doc` de `sets.light`).',
            infra: 'corrigir a chave ou a cota citada. A próxima noite mede de novo.',
            ungated: 'o run não bateu com a calibração (modelo ou juiz diferente). Ver `evals/investigation/targets.json`.',
        }[verdict];
        if (next) lines.push('', `**Próximo passo:** ${next}`);
    }
    if (url) lines.push(`Run: ${url}`);

    const description = lines.join('\n');
    const perPr = comparison
        ? [
              '',
              '<details><summary>Por PR (comparado com a última noite verde)</summary>',
              '',
              '| PR | antes | agora | bugs perdidos | bugs novos |',
              '| --- | --- | --- | --- | --- |',
              ...comparison.perCase.map((c) => `| ${c.caseId} | ${pct(c.recallBefore)} | ${pct(c.recall)} | ${c.lost ? c.lost.map((g) => clip(g, 80)).join('<br>') : 'n/d'} | ${c.gained ? c.gained.map((g) => clip(g, 80)).join('<br>') : 'n/d'} |`),
              '',
              '</details>',
          ]
        : [];
    const markdown = [`## ${title}`, '', description.replace(/\n/g, '  \n'), ...perPr].join('\n');
    return { status, verdict, title, description, markdown };
}

// ── tier-0 ───────────────────────────────────────────────────────────────────

const T0_ICON = { pass: '✅', broken: '❌', infra: '⚠️', skipped: '➖', missing: '❓' };

function sameFailure(now, before) {
    if (!before) return false;
    const key = (r) => `${r.status}|${clip(r.reason, 120)}|${r.prSummary?.status}|${clip(r.prSummary?.reason, 120)}`;
    return now.status !== 'pass' && key(now) === key(before);
}

function tier0Line(r, previous) {
    const review = {
        pass: `review ok (${r.toolCalls} tool calls, ${r.findings} findings, ${r.seconds}s)`,
        broken: `review quebrada: ${clip(r.reason, 160)}`,
        infra: `não alcançado: ${clip(r.reason, 160)}`,
        missing: 'sem resultado (o job caiu ou estourou o tempo)',
    }[r.status] || r.status;
    const summaryStatus = r.prSummary?.status;
    const summary =
        summaryStatus === 'pass'
            ? 'resumo ok'
            : summaryStatus && summaryStatus !== 'skipped' && r.status !== 'missing'
              ? `resumo ${summaryStatus === 'infra' ? 'não alcançado' : summaryStatus === 'missing' ? 'sem resultado' : 'quebrado'}`
              : null;
    const repeat = sameFailure(r, previous) ? ' _(igual à semana passada)_' : '';
    return `${T0_ICON[r.status] || '❓'} **${r.model}**: ${[review, summary].filter(Boolean).join(' · ')}${repeat}`;
}

function tier0Report(models, readResult, env = {}, readPrevious = () => null) {
    const url = runUrl(env);
    const results = models.map(
        (model) => readResult(model) || { model, status: 'missing', reason: 'sem resultado', prSummary: { status: 'missing' } },
    );

    const outcomes = (r) => [r.status, r.prSummary?.status];
    const missing = results.filter((r) => r.status === 'missing');
    const broken = results.filter((r) => !missing.includes(r) && outcomes(r).includes('broken'));
    const unreachable = results.filter((r) => !missing.includes(r) && !broken.includes(r) && outcomes(r).includes('infra'));
    const ok = results.length - missing.length - broken.length - unreachable.length;
    const names = (list) => list.map((r) => r.model).join(', ');

    let status = 'success';
    let verdict = 'pass';
    const parts = [];
    if (broken.length) parts.push(`${names(broken)} não ${broken.length === 1 ? 'revisa' : 'revisam'} mais`);
    if (missing.length) parts.push(`${names(missing)} sem resultado`);
    if (unreachable.length) parts.push(`sem acesso a ${names(unreachable)}`);
    if (broken.length || missing.length) {
        status = 'failure';
        verdict = 'regression';
    } else if (unreachable.length) {
        status = 'failure';
        verdict = 'infra';
    }
    const headline = parts.length
        ? `${ok}/${results.length} ok · ${parts.join(' · ')}`
        : results.length === 1
          ? `${results[0].model} revisa`
          : `os ${results.length} modelos revisam`;
    const title = `${verdict === 'pass' ? '✅' : verdict === 'infra' ? '⚠️' : '❌'} Tier-0: ${headline}`;

    const lines = results.map((r) => tier0Line(r, readPrevious(r.model)));
    const next = [];
    if (broken.length) next.push('• Modelo quebrado afeta quem usa esse modelo hoje: decidir por modelo (segurar, trocar o padrão ou avisar os clientes).');
    if (missing.length) next.push('• Sem resultado: o job caiu ou estourou o tempo; o log está no run.');
    if (unreachable.length) next.push('• Sem acesso: corrigir a chave ou a cota do fornecedor (o motivo está na linha).');
    if (next.length) lines.push('', '**Próximo passo:**', ...next);
    if (url) lines.push(`Run: ${url}`);

    const description = lines.join('\n');
    const markdown = [`## ${title}`, '', ...description.split('\n').map((line) => (line ? `${line}  ` : line))].join('\n');
    return { status, verdict, title, description, markdown };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flag(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
}

function readCommits(file) {
    if (!file) return [];
    try {
        return fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [sha, subject, author] = line.split('\t');
                return { sha, subject, author };
            });
    } catch {
        return [];
    }
}

module.exports = { nightlyReport, tier0Report };

if (require.main === module) {
    const [mode, target] = process.argv.slice(2);
    if (mode === 'nightly' && target) {
        emit(
            nightlyReport(readJson(target), process.env, {
                lastGreen: flag('last-green') ? readJson(flag('last-green')) : null,
                commits: readCommits(flag('commits')),
                investigation: flag('investigation') ? readJson(flag('investigation')) : null,
                targets: readJson(path.join(__dirname, 'investigation', 'targets.json')),
            }),
        );
    } else if (mode === 'tier0' && target) {
        // EVAL_MODELS: the models this run was asked for (a dispatch can pin one).
        const models = process.env.EVAL_MODELS ? JSON.parse(process.env.EVAL_MODELS) : require('./shared/tier0-models').tier0();
        const fileFor = (dir, model) => path.join(dir, `tier0-smoke-${model.replace(/[^\w.-]+/g, '-')}.json`);
        const previous = flag('previous');
        emit(
            tier0Report(
                models,
                (model) => readJson(fileFor(target, model)),
                process.env,
                (model) => (previous ? readJson(fileFor(previous, model)) : null),
            ),
        );
    } else {
        console.error('usage: node evals/ci-report.js nightly <result.json> [--last-green=… --commits=… --investigation=…] | tier0 <dir> [--previous=<dir>]');
        process.exit(2);
    }
}
