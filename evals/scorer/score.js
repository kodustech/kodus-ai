/**
 * Scorer do benchmark — núcleo puro.
 *
 * Separa PONTUAR de RODAR. Recebe uma submission (findings por caso, venha de
 * onde vier: Kodus, Claude Code, Codex, Greptile, terceiro via PR) e devolve um
 * scorecard. Não chama modelo de review nenhum — só o judge.
 *
 * Por que separado:
 *   - re-pontuar com outro judge não exige re-rodar os modelos (uma passada do
 *     corpus custa ~US$ 15–80 por modelo; o judge custa centavos)
 *   - terceiros podem submeter sem acesso ao harness da Kodus
 *   - as findings ficam persistidas (o run-recall antigo as descartava, o que
 *     deixava as páginas de trace do site sem dado)
 *
 * O algoritmo de matching é o MESMO de recall-assertion.js (mesmo judge, mesma
 * lógica par-a-par, mesmas métricas), para os números seguirem comparáveis com
 * o histórico. Ver evals/scorer/README.md para o contrato dos formatos.
 */
const { matchCommentWith } = require('../investigation/recall-judge');

const STOPWORDS =
    /^(this|self|true|false|null|none|with|that|when|then|from|will|have|been|which|these|there|where|while|should|could|would|because|without|value|values|method|function|class|object|return|input|output|param|params|error|check|other|using|used|into|only|note|here)$/i;

function extractCodeTokens(text) {
    const s = String(text || '');
    const tokens = new Set();
    for (const m of s.matchAll(/`([^`]{2,60})`/g)) tokens.add(m[1]);
    for (const m of s.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(/g)) tokens.add(m[1]);
    for (const m of s.matchAll(/\b([a-zA-Z]+[a-z][A-Z][a-zA-Z0-9]{2,})\b/g)) tokens.add(m[1]);
    for (const m of s.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]{2,})\b/g)) tokens.add(m[1]);
    for (const m of s.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]+)\b/g)) tokens.add(m[1]);
    return [...tokens]
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !STOPWORDS.test(t));
}

function codeInCorpus(goldenText, corpus) {
    if (!corpus) return { present: null, hits: [] };
    const tokens = extractCodeTokens(goldenText);
    if (!tokens.length) return { present: null, hits: [] };
    const hits = tokens.filter((t) => corpus.includes(t));
    return { present: hits.length > 0, hits };
}

/**
 * Normaliza um finding para o texto que o judge compara.
 * Aceita o formato PÚBLICO da submission e o formato INTERNO do engine Kodus,
 * para submissions antigas e de terceiros funcionarem no mesmo scorer.
 */
function findingToText(f) {
    if (!f || typeof f !== 'object') return String(f || '');
    const parts = [
        // formato público
        f.description,
        f.category,
        f.path,
        // formato interno Kodus (retrocompat)
        f.oneSentenceSummary,
        f.suggestionContent,
        f.label,
        f.relevantFile,
    ];
    return [...new Set(parts.filter(Boolean))].join(' — ');
}

function goldenToText(g) {
    if (typeof g === 'string') return g;
    return String((g && (g.comment || g.body || g.description)) || '');
}

/**
 * Pontua UM caso.
 *
 * @param {object[]} findings  findings submetidas para o caso
 * @param {any[]}    goldens   golden comments do dataset
 * @param {string}   corpus    código que o harness pôde ver (só modo replay; '' desativa fairness)
 * @param {object}   trace     opcional: { replayCalls, unexpectedToolCalls } para loop-fidelity
 * @param {object}   judge     { model, apiKey }
 */
async function scoreCase({ findings, goldens, corpus = '', trace = null, judge }) {
    const candidates = (findings || []).map(findingToText);
    const goldenTexts = (goldens || []).map(goldenToText);

    if (!goldenTexts.length) {
        return { skipped: true, reason: 'caso sem goldenComments — nada a pontuar' };
    }

    // Matching par-a-par, idêntico a recall-assertion.js: um golden pode ser
    // coberto por vários findings e vice-versa; pula o par só quando ambos os
    // lados já estão decididos.
    const goldenHit = new Array(goldenTexts.length).fill(false);
    const findingHit = new Array(candidates.length).fill(false);
    for (let gi = 0; gi < goldenTexts.length; gi++) {
        for (let fi = 0; fi < candidates.length; fi++) {
            if (goldenHit[gi] && findingHit[fi]) continue;
            // eslint-disable-next-line no-await-in-loop
            if (await matchCommentWith(judge.model, judge.apiKey, goldenTexts[gi], candidates[fi])) {
                goldenHit[gi] = true;
                findingHit[fi] = true;
            }
        }
    }

    const matched = goldenHit.filter(Boolean).length;
    const tpFindings = findingHit.filter(Boolean).length;
    const fpFindings = candidates.length - tpFindings;

    const missed = [];
    for (let gi = 0; gi < goldenTexts.length; gi++) {
        if (goldenHit[gi]) continue;
        missed.push({ text: goldenTexts[gi], fair: codeInCorpus(goldenTexts[gi], corpus) });
    }
    const realMiss = missed.filter((m) => m.fair.present === true).length;
    const artifact = missed.filter((m) => m.fair.present === false).length;
    const untestable = missed.filter((m) => m.fair.present === null).length;

    const recall = matched / goldenTexts.length;
    const precision = candidates.length ? tpFindings / candidates.length : 0;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    const fairDenom = matched + realMiss + untestable;
    const fairRecall = fairDenom ? matched / fairDenom : recall;

    // loop-fidelity só faz sentido em modo replay com trace; senão é null (não 1),
    // para não inventar confiança que não foi medida.
    let hitRate = null;
    let totalCalls = null;
    let unserved = null;
    if (trace && typeof trace.replayCalls === 'number') {
        unserved = Array.isArray(trace.unexpectedToolCalls)
            ? trace.unexpectedToolCalls.length
            : Number(trace.unexpectedToolCalls || 0);
        totalCalls = trace.replayCalls;
        hitRate = totalCalls ? Math.max(0, (totalCalls - unserved) / totalCalls) : 1;
    }

    return {
        recall,
        precision,
        f1,
        fairRecall,
        hitRate,
        totalCalls,
        unserved,
        matched,
        goldens: goldenTexts.length,
        findings: candidates.length,
        tpFindings,
        fpFindings,
        realMiss,
        artifact,
        untestable,
        missedGoldens: missed.map((m) => ({
            text: m.text.slice(0, 200),
            classification:
                m.fair.present === true
                    ? 'real-miss'
                    : m.fair.present === false
                      ? 'not-in-corpus'
                      : 'untestable',
        })),
    };
}

function mean(xs) {
    const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Pontua uma submission inteira e devolve o scorecard.
 *
 * @param {object} submission  ver README.md
 * @param {Map}    dataset     caseId -> { goldens, corpus }
 * @param {object} judge       { model, apiKey }
 */
async function scoreSubmission({ submission, dataset, judge, onProgress, concurrency = 6 }) {
    const input = submission.results || [];
    const cases = new Array(input.length);
    let done = 0;

    // Pool: cada caso são goldens × findings chamadas ao judge, em série dentro
    // do caso. Sequencial entre casos, um corpus de 30 vira ~360 chamadas em
    // fila e estoura qualquer timeout razoável. Os casos são independentes.
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const i = cursor++;
            if (i >= input.length) return;
            const r = input[i];
            const entry = dataset.get(r.caseId);
            if (!entry) {
                cases[i] = { caseId: r.caseId, status: 'unknown-case' };
            } else {
                // eslint-disable-next-line no-await-in-loop
                const m = await scoreCase({
                    findings: r.findings,
                    goldens: entry.goldens,
                    corpus: submission.run?.executionMode === 'replay' ? entry.corpus : '',
                    trace: r.trace || null,
                    judge,
                });
                cases[i] = m.skipped
                    ? { caseId: r.caseId, status: 'skipped', reason: m.reason }
                    : {
                          caseId: r.caseId,
                          status: 'scored',
                          metrics: m,
                          usage: r.usage || null,
                          latencyMs: r.latencyMs ?? null,
                          // propagado para o scorecard: recall baixo com
                          // finishReason de truncamento é artefato de rota, não
                          // qualidade de modelo.
                          finishReason: r.trace?.finishReason ?? null,
                          steps: r.trace?.steps ?? null,
                      };
            }
            done += 1;
            if (onProgress) onProgress(cases[i], done, input.length);
        }
    };
    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, input.length)) }, worker),
    );

    const scored = cases.filter((c) => c.status === 'scored');
    const totalGoldens = scored.reduce((s, c) => s + c.metrics.goldens, 0);
    const totalMatched = scored.reduce((s, c) => s + c.metrics.matched, 0);
    const usage = scored.reduce(
        (acc, c) => {
            acc.inputTokens += c.usage?.inputTokens || 0;
            acc.outputTokens += c.usage?.outputTokens || 0;
            return acc;
        },
        { inputTokens: 0, outputTokens: 0 },
    );

    return {
        benchmarkVersion: submission.benchmarkVersion,
        run: submission.run,
        scoredAt: new Date().toISOString(),
        judge: { model: judge.model },
        aggregate: {
            cases: cases.length,
            casesScored: scored.length,
            // micro = pondera por golden (o número honesto p/ ranking);
            // macro = média das médias por caso (comparável com o histórico).
            recallMicro: totalGoldens ? totalMatched / totalGoldens : null,
            recallMacro: mean(scored.map((c) => c.metrics.recall)),
            precisionMacro: mean(scored.map((c) => c.metrics.precision)),
            f1Macro: mean(scored.map((c) => c.metrics.f1)),
            fairRecallMacro: mean(scored.map((c) => c.metrics.fairRecall)),
            loopFidelityMacro: mean(scored.map((c) => c.metrics.hitRate)),
            goldensTotal: totalGoldens,
            goldensMatched: totalMatched,
            usage,
        },
        cases,
    };
}

module.exports = { scoreCase, scoreSubmission, findingToText, goldenToText, codeInCorpus };
