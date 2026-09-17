#!/usr/bin/env node
// Turns eval results into what a human reads: the Actions job summary and the
// Discord message. Reads result files only — it never runs an eval.
//
//   node evals/ci-report.js nightly <result.json> [--last-green=<result.json>]
//        [--commits=<tsv: sha, subject, author>] [--investigation=<json>]
//        [--previous-state=<json>] [--state-out=<json>]
//   node evals/ci-report.js tier0 <dir> [--previous=<dir>]
//
// Writes markdown to $GITHUB_STEP_SUMMARY and `status`, `verdict`, `mention`,
// `title`, `description` to $GITHUB_OUTPUT when those are set; prints them
// otherwise. `mention` is true only for a new or worsening confirmed drop.
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

// A provider/judge error in two or three words, for titles and one-liners.
function shortReason(text) {
    const t = String(text || '');
    const who = /judge/i.test(t) ? 'juiz: ' : '';
    const kind =
        /no api key|missing .*key|set JUDGE_API_KEY/i.test(t) ? 'sem chave'
        : /(invalid|incorrect|expired).{0,20}(api.?key|key|token)|(api.?key|x-api-key|token).{0,20}(invalid|incorrect|expired)|unauthori[sz]ed|\b40[13]\b/i.test(t) ? 'chave inválida'
        : /insufficient|balance|credit|billing|\b402\b|suspended/i.test(t) ? 'sem crédito'
        : /quota|rate.?limit|\b429\b|exhausted/i.test(t) ? 'limite de uso'
        : /overloaded|\b50[23]\b/i.test(t) ? 'provedor sobrecarregado'
        : /cannot connect|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(t) ? 'sem conexão'
        : /no finding/i.test(t) ? 'nenhum finding'
        : /tool call/i.test(t) ? 'não usa ferramentas'
        : null;
    return kind ? `${who}${kind}` : clip(t, 60);
}

function firstSentence(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    const end = s.search(/[.!?](\s|$)/);
    return end > 0 ? s.slice(0, end) : s;
}

const md = (label, href) => (href ? `[${label}](${href})` : null);

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

function emit({ status, verdict, mention = false, state = null, title, description, markdown }, stateOut = null) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    else console.log(markdown);
    if (stateOut && state) fs.writeFileSync(stateOut, JSON.stringify(state, null, 2));
    if (process.env.GITHUB_OUTPUT) {
        const delimiter = `EOF_${Date.now()}`;
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `status=${status}\nverdict=${verdict}\nmention=${mention}\ntitle=${title}\ndescription<<${delimiter}\n${description}\n${delimiter}\n`,
        );
    }
    console.log(`\n${title}\n${description}`);
}

// ── nightly ──────────────────────────────────────────────────────────────────

// What the gate says, in order of what matters: a run that measured nothing is
// not a quality result; a collapse (no findings, no tool calls) is the engine
// breaking, not recall wobbling.
//
// Only a confirmed drop (two runs, their mean below the floor) is a regression,
// and only a new or worsening one mentions people: a drop that already alerted
// and hasn't changed stays red without pinging again.
const RED = new Set(['regression', 'still-red']);

function nightlyVerdict(result, comparison, noise, previousState) {
    if (!result) return { verdict: 'infra', title: 'não produziu resultado' };
    if (result.error) return { verdict: 'infra', title: 'não mediu' };
    if (result.confirmationError) return { verdict: 'infra', title: 'ficou abaixo do piso, mas a confirmação não mediu' };
    const infra = result.infraFailures || 0;
    if (infra > 0) return { verdict: 'infra', title: `${infra} de ${result.cases} PRs não medidos` };

    const gate = result.gate || {};
    const failed = (gate.checks || []).filter((check) => !check.pass).map((check) => check.name);
    if (gate.status === 'fail') {
        const recall = result.metrics?.recall_mean;
        const wasRed = Boolean(previousState && RED.has(previousState.verdict));
        const day = wasRed ? (previousState.streak || 1) + 1 : null;
        // A collapse is the engine breaking: it alerts even during a red streak,
        // unless it's the collapse that streak already alerted for.
        const collapse = newCollapse(failed, previousState);
        if (collapse) return { verdict: 'regression', title: `${COLLAPSE_TITLE[collapse]}${day ? ` (dia ${day})` : ''}` };
        if (wasRed) {
            const worse = typeof recall === 'number' && typeof previousState.recall === 'number' && recall < previousState.recall - (noise || 0.05);
            return worse
                ? { verdict: 'regression', title: `piorou: recall caiu mais ${points(recall - previousState.recall)} (dia ${day})` }
                : { verdict: 'still-red', title: `continua abaixo do piso (dia ${day})` };
        }
        const delta = comparison?.recallDelta;
        return {
            verdict: 'regression',
            title: typeof delta === 'number' && delta < 0 ? `recall caiu ${points(delta)}, abaixo do piso` : 'recall abaixo do piso',
        };
    }
    if (gate.status !== 'pass') return { verdict: 'ungated', title: 'não comparou com o piso' };
    if (gate.confirmation) return { verdict: 'oscillation', title: 'oscilou abaixo do piso, a confirmação passou' };

    const delta = comparison?.recallDelta;
    if (typeof delta === 'number' && noise && delta >= 2 * noise) return { verdict: 'improved', title: `recall subiu ${points(delta)}` };
    return { verdict: 'pass', title: 'qualidade estável' };
}

const COLLAPSE_TITLE = { mean_tool_calls: 'o finder parou de usar as ferramentas', mean_findings: 'o finder parou de produzir findings' };

// The collapse check failing tonight that the current red streak hasn't
// already alerted for, if any.
function newCollapse(failed, previousState) {
    const alerted = previousState && RED.has(previousState.verdict) ? previousState.failed || [] : [];
    return Object.keys(COLLAPSE_TITLE).find((check) => failed.includes(check) && !alerted.includes(check)) || null;
}

// What the next night needs to know: whether this night is red, since when,
// the recall it alerted at (to tell "still red" from "worse") and the checks
// that failed (so a later collapse still alerts).
function nextState(verdict, result, previousState, today) {
    const red = RED.has(verdict);
    const continuing = red && previousState && RED.has(previousState.verdict);
    return {
        verdict,
        recall: result?.metrics?.recall_mean ?? null,
        failed: red ? (result?.gate?.checks || []).filter((check) => !check.pass).map((check) => check.name) : [],
        streak: red ? (continuing ? (previousState.streak || 1) + 1 : 1) : 0,
        since: red ? (continuing ? previousState.since : today) : null,
    };
}

const ICON = { pass: '✅', improved: '📈', oscillation: '⚠️', regression: '❌', 'still-red': '❌', infra: '⚠️', ungated: '⚠️' };

function nightlyReport(result, env = {}, extras = {}) {
    const { lastGreen = null, commits = [], investigation = null, targets = null, previousState = null, today = new Date().toISOString().slice(0, 10) } = extras;
    const url = runUrl(env);
    const { EVAL_BASE_SHA: base, GITHUB_SHA: head, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;
    const compareUrl = base && head && base !== head ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/compare/${base.slice(0, 12)}...${head.slice(0, 12)}` : null;

    const comparison = result && lastGreen && !result.error ? compareNights(result, lastGreen) : null;
    const noise = targets && result ? nightNoise(targets, 'light', result.model) : null;
    const { verdict, title: headline } = nightlyVerdict(result, comparison, noise, previousState);
    const title = `${ICON[verdict]} Evals noturnos: ${headline}`;
    const status = ['pass', 'improved', 'oscillation'].includes(verdict) ? 'success' : 'failure';
    const mention = verdict === 'regression';
    const state = nextState(verdict, result, previousState, today);
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
        if (result.confirmationError) {
            lines.push('', `A primeira medição ficou abaixo do piso; a confirmação não mediu (${clip(result.confirmationError, 160)}). Nada foi confirmado.`);
        }
        const confirmation = result.gate?.confirmation;
        if (confirmation && Array.isArray(confirmation.runs)) {
            lines.push(`Duas medições no mesmo commit: ${confirmation.runs.map(pct).join(' e ')} (média ${pct(result.metrics?.recall_mean)}${typeof floor === 'number' ? `, piso ${pct(floor)}` : ''})`);
        }
        if (verdict === 'still-red' && previousState?.since) {
            lines.push(`Abaixo do piso desde ${previousState.since}. Sem menção: o alerta já saiu, e a próxima só sai se piorar.`);
        }

        if (comparison && (RED.has(verdict) || verdict === 'improved')) {
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

        if (investigation && RED.has(verdict)) {
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
            'still-red': 'a mesma queda segue sem correção. Quem estiver com ela: corrigir ou recalibrar `sets.light` se for intencional.',
            oscillation: 'nada. Uma medição isolada abaixo do piso é ruído quando a repetição passa.',
            improved: 'se a melhora se repetir na próxima noite, subir o piso (regra no `__doc` de `sets.light`).',
            infra: 'corrigir a chave ou a cota citada. A próxima noite mede de novo.',
            ungated: 'o run não bateu com a calibração (modelo ou juiz diferente). Ver `evals/investigation/targets.json`.',
        }[verdict];
        if (next) lines.push('', `**Próximo passo:** ${next}`);
    }
    if (url) lines.push(`Run: ${url}`);

    const detailed = lines.join('\n');
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
    const markdown = [`## ${title}`, '', detailed.replace(/\n/g, '  \n'), ...perPr].join('\n');
    const compact = nightlyCompact({ result, verdict, comparison, commits, investigation, previousState, url, compareUrl });
    return { status, verdict, mention, state, title: compact.title, description: compact.description, markdown };
}

// The Discord version: a title with the numbers, then short labelled blocks —
// what moved, which bugs, which commits, the agent's lead, what to do — each a
// line or two. The long form stays in the run summary.
//
// The nightly workflow passes only these secrets (the model's key as
// BYOK_FIREWORKS_API_KEY, the judge's as JUDGE_API_KEY), so they are the ones
// its runs resolve.
const SECRET_FOR = { juiz: 'BYOK_OPENAI_API_KEY', model: 'BYOK_FIREWORKS_API_KEY' };
const ACCOUNT_FOR = { juiz: 'OpenAI', model: 'Fireworks' };

// What to do about a provider refusal: a key is fixed in the secret, credit on
// the provider account, a rate limit only by waiting for the next night.
function infraNextStep(reason) {
    const who = reason.startsWith('juiz') ? 'juiz' : 'model';
    if (/chave/.test(reason)) return `corrigir \`${SECRET_FOR[who]}\``;
    if (/crédito/.test(reason)) return `pôr crédito na conta ${ACCOUNT_FOR[who]}`;
    if (/limite/.test(reason)) return `limite de uso da ${ACCOUNT_FOR[who]}; se repetir, pedir aumento`;
    return 'ver o log do run';
}

function nightlyCompact({ result, verdict, comparison, commits, investigation, previousState, url, compareUrl }) {
    const links = [md('run', url), md('diff', compareUrl)].filter(Boolean).join(' · ');
    const recall = result?.metrics?.recall_mean;
    const precision = result?.metrics?.precision_mean;
    const gate = result?.gate || {};
    const floor = (gate.checks || []).find((check) => check.name === 'recall_mean')?.floor;
    const failed = (gate.checks || []).filter((check) => !check.pass).map((check) => check.name);
    const runs = Array.isArray(gate.confirmation?.runs) ? gate.confirmation.runs : null;
    const delta = comparison?.recallDelta;
    const signed = (d) => `${d >= 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)} pts`;
    const day = previousState && RED.has(previousState.verdict) ? (previousState.streak || 1) + 1 : null;
    const collapse = verdict === 'regression' ? newCollapse(failed, previousState) : null;
    const infraReason = result?.error || result?.confirmationError || (result?.rows || []).find((row) => row.status === 'infra')?.reason;
    const minutes = result ? minutesBetween(result.startedAt, result.finishedAt) : null;
    const cost = result ? costUpperBound(result.tokens, catalogIdFor(result.model)) : null;
    const money = typeof cost === 'number' ? `US$ ${cost.toFixed(2).replace('.', ',')}` : null;
    const measured = result ? result.cases - (result.infraFailures || 0) : 0;

    let title;
    if (verdict === 'pass') title = `✅ Evals · recall ${pct(recall)} · estável`;
    else if (verdict === 'improved') title = `📈 Evals · recall ${pct(recall)} (${signed(delta)})`;
    else if (verdict === 'oscillation') title = '⚠️ Evals · oscilou, repetição passou';
    else if (verdict === 'infra') title = `⚠️ Evals · não mediu${shortReason(infraReason) !== clip(infraReason, 60) ? ` · ${shortReason(infraReason)}` : ''}`;
    else if (verdict === 'ungated') title = '⚠️ Evals · não comparou com o piso';
    else if (verdict === 'still-red') title = `❌ Evals · ainda abaixo do piso · dia ${day}`;
    else if (collapse === 'mean_tool_calls') title = `❌ Evals · finder parou de usar ferramentas${day ? ` · dia ${day}` : ''}`;
    else if (collapse === 'mean_findings') title = `❌ Evals · finder parou de gerar findings${day ? ` · dia ${day}` : ''}`;
    else if (day) title = `❌ Evals · piorou · recall ${pct(recall)} · dia ${day}`;
    else title = `❌ Evals · recall ${pct(recall)}${typeof delta === 'number' ? ` (${signed(delta)})` : ''}${typeof floor === 'number' ? ` · piso ${pct(floor)}` : ''}`;

    const lines = [];
    const numbers = (withFloor = true) => {
        const recallPart = `**Recall** ${pct(recall)}${comparison?.recallBefore != null ? ` (verde: ${pct(comparison.recallBefore)})` : ''}`;
        const precisionPart = `**precisão** ${pct(precision)}${comparison?.precisionBefore != null ? ` (${pct(comparison.precisionBefore)})` : ''}`;
        return [recallPart, precisionPart, withFloor && typeof floor === 'number' ? `piso ${pct(floor)}` : null].filter(Boolean).join(' · ');
    };
    const runLine = () => [`${measured}/${result.cases} PRs`, minutes ? `${minutes} min` : null, money].filter(Boolean).join(' · ');
    const commitBlock = (label, max) => {
        if (!commits.length) return;
        lines.push('', `**${label} (${commits.length})**`);
        for (const c of commits.slice(0, max)) lines.push(`• \`${c.sha}\` ${clip(c.subject, 60)} — ${c.author}`);
        if (commits.length > max) lines.push(`• +${commits.length - max} no diff`);
    };

    if (verdict === 'infra' || verdict === 'ungated') {
        const raw = verdict === 'infra' ? infraReason : gate.reason;
        lines.push(`**Erro:** ${clip(raw, 140)}`);
        if (verdict === 'infra') {
            lines.push(`**Próximo passo:** ${infraNextStep(shortReason(raw))}. A próxima noite mede de novo.`);
        } else {
            lines.push('**Próximo passo:** o run não bateu com a calibração (modelo ou juiz). Ver `targets.json`.');
        }
    } else if (verdict === 'oscillation') {
        lines.push(`**Medições:** ${runs ? runs.map(pct).join(' e ') : 'n/d'} · média ${pct(recall)} · piso ${pct(floor)}`);
        lines.push(numbers(false), runLine());
        lines.push('Uma medição caiu, a repetição não confirmou. Nada a fazer.');
    } else if (verdict === 'pass' || verdict === 'improved') {
        lines.push(numbers(), runLine());
        commitBlock('Commits medidos', 3);
        if (verdict === 'improved') lines.push('', '**Próximo passo:** se repetir na próxima noite, subir o piso.');
    } else {
        // regression / still-red
        lines.push(numbers(verdict === 'still-red'), [runLine(), runs ? `medições ${runs.map(pct).join(' e ')}` : null].filter(Boolean).join(' · '));
        if (verdict === 'still-red' && previousState?.since) {
            lines.push(`Alertado em ${previousState.since}${typeof previousState.recall === 'number' ? ` com ${pct(previousState.recall)}` : ''}. Sem @here até piorar.`);
        }
        if (comparison && verdict !== 'still-red') {
            const lostCases = comparison.perCase.filter((c) => c.delta < 0 && (c.lost === null || c.lost.length));
            const total = comparison.lostTotal;
            if (lostCases.length) {
                lines.push('', `**${total != null ? `Bugs perdidos (${total})` : 'PRs que mais caíram'}**`);
                for (const c of lostCases.slice(0, 3)) {
                    const bug = c.lost && c.lost.length ? `: "${clip(c.lost[0], 70)}"${c.lost.length > 1 ? ` +${c.lost.length - 1}` : ''}` : '';
                    lines.push(`• ${clip(c.caseId, 38)} ${Math.round(c.recallBefore * 100)}→${pct(c.recall)}${bug}`);
                }
            }
        }
        commitBlock(verdict === 'still-red' ? 'Commits desde o alerta' : 'Commits', 3);
        if (investigation) {
            const reading = { regression: 'provável regressão', noise: 'provavelmente ruído', eval: 'problema do eval', unclear: 'inconclusivo' }[investigation.verdict] || 'hipótese';
            lines.push('', `**🤖 Claude** · ${reading} · confiança ${investigation.confidence}`);
            lines.push(clip(investigation.summary, 180));
            const suspect = (investigation.suspects || [])[0];
            const where = suspect ? [suspect.commit && `\`${suspect.commit}\``, suspect.file && `\`${suspect.file.split('/').pop()}\``].filter(Boolean).join(' ') : '';
            const confirm = investigation.confirm ? `confirmar: ${clip(investigation.confirm, 90)}` : '';
            if (where || confirm) lines.push([where && `suspeito: ${where}`, confirm].filter(Boolean).join(' · '));
        } else if (verdict === 'regression') {
            lines.push('', '**Próximo passo:** `pnpm eval:nightly` no commit anterior e no suspeito.');
        }
    }
    if (links) lines.push('', links);
    return { title, description: lines.join('\n') };
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

    const detailedLines = results.map((r) => tier0Line(r, readPrevious(r.model)));
    const lines = detailedLines;
    const next = [];
    if (broken.length) next.push('• Modelo quebrado afeta quem usa esse modelo hoje: decidir por modelo (segurar, trocar o padrão ou avisar os clientes).');
    if (missing.length) next.push('• Sem resultado: o job caiu ou estourou o tempo; o log está no run.');
    if (unreachable.length) next.push('• Sem acesso: corrigir a chave ou a cota do fornecedor (o motivo está na linha).');
    if (next.length) lines.push('', '**Próximo passo:**', ...next);
    if (url) lines.push(`Run: ${url}`);

    const markdown = [`## ${title}`, '', ...lines.map((line) => (line ? `${line}  ` : line))].join('\n');

    // Discord: the healthy models in one line, then each problem with its short
    // cause, the raw error and what to do.
    const okModels = results.filter((r) => !missing.includes(r) && !broken.includes(r) && !unreachable.includes(r));
    const icon = verdict === 'pass' ? '✅' : verdict === 'infra' ? '⚠️' : '❌';
    const secretFor = (model) =>
        /^claude/.test(model) ? 'BYOK_ANTHROPIC_API_KEY' : /^gpt/.test(model) ? 'BYOK_OPENAI_API_KEY' : /^gemini/.test(model) ? 'BYOK_GOOGLE_API_KEY' : /^kimi/.test(model) ? 'BYOK_MOONSHOT_API_KEY' : /^glm/.test(model) ? 'BYOK_ZHIPU_API_KEY' : null;
    const compactLines = [];
    if (okModels.length) compactLines.push(`✅ ${okModels.map((r) => r.model).join(' · ')}`);
    for (const r of [...broken, ...missing, ...unreachable]) {
        const reviewBroken = r.status !== 'pass';
        const raw = r.status === 'missing' ? null : reviewBroken ? r.reason : r.prSummary?.reason;
        const why = r.status === 'missing' ? 'sem resultado, o job caiu' : `${reviewBroken ? 'review' : 'resumo'}: ${shortReason(raw)}`;
        const repeat = sameFailure(r, readPrevious(r.model)) ? ' (igual semana passada)' : '';
        compactLines.push(`${r.status === 'missing' ? '❓' : broken.includes(r) ? '❌' : '⚠️'} **${r.model}** · ${why}${repeat}`);
        const detail = [];
        if (raw) detail.push(`\`${clip(raw, 90)}\``);
        if (unreachable.includes(r) && secretFor(r.model)) detail.push(`corrigir \`${secretFor(r.model)}\``);
        if (broken.includes(r)) detail.push('clientes nesse modelo afetados');
        if (detail.length) compactLines.push(`   ${detail.join(' → ')}`);
    }
    if (url) compactLines.push('', md('run', url));
    return {
        status,
        verdict,
        title: `${icon} Tier-0 · ${ok}/${results.length} ${results.length === 1 ? 'modelo ok' : 'modelos ok'}`,
        description: compactLines.join('\n'),
        markdown,
    };
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
                previousState: flag('previous-state') ? readJson(flag('previous-state')) : null,
                targets: readJson(path.join(__dirname, 'investigation', 'targets.json')),
            }),
            flag('state-out'),
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
