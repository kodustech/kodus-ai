#!/usr/bin/env node
// Direct finder-recall runner.
//
// This intentionally bypasses promptfoo so local and CI use the same Node
// entrypoint without npx/network dependency. It runs the live generalist finder
// through deterministic tool replay, then scores findings against golden bugs
// with the same recall-assertion judge.
const fs = require('fs');
const path = require('path');

const buildTests = require('./recall-tests');
const { TIER0, defaultMatrix } = require('../shared/tier0-models');

const RESULTS_DIR = path.join(__dirname, 'results');

const KNOWN_FLAGS = new Set([
    'model',
    'all',
    'set',
    'cases',
    'limit',
    'threshold',
    'output',
    'concurrency',
    'list-models',
    'listModels',
    'gate',
    'no-judge',
]);

function parseArgs(argv) {
    const out = {
        model:
            process.env.FINDER_MODEL || process.env.RECALL_MODEL || 'gpt-5.4',
        all: process.env.RECALL_ALL === '1',
        set: process.env.RECALL_SET || 'pr',
        cases: process.env.RECALL_CASES || '',
        limit: null,
        threshold:
            process.env.FINDER_RECALL_THRESHOLD ||
            process.env.RECALL_THRESHOLD ||
            '',
        output: '',
        concurrency: Number(process.env.RECALL_CONCURRENCY) || 4,
        listModels: false,
        noJudge: process.env.RECALL_NO_JUDGE === '1',
        gate: process.env.RECALL_GATE === '1',
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;

        const key = m[1];
        if (!KNOWN_FLAGS.has(key)) {
            // A silent no-op here is how `--no-judge` did nothing on its first
            // run, and how a mistyped `--set` would quietly measure the default
            // set instead of the one asked for.
            console.error(
                `unknown flag --${key}. Known: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(' ')}`,
            );
            process.exit(2);
        }
        const inlineValue = m[2];
        const value = inlineValue ?? argv[i + 1];
        const consumesNext =
            inlineValue === undefined &&
            value &&
            !String(value).startsWith('--');

        if (key === 'model') {
            out.model = value || out.model;
            if (consumesNext) i += 1;
        } else if (key === 'all') {
            out.all = true;
        } else if (key === 'no-judge') {
            out.noJudge = true;
        } else if (key === 'set') {
            out.set = value || out.set;
            if (consumesNext) i += 1;
        } else if (key === 'cases') {
            out.cases = value || '';
            if (consumesNext) i += 1;
        } else if (key === 'limit') {
            out.limit = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'threshold') {
            out.threshold = value || '';
            if (consumesNext) i += 1;
        } else if (key === 'output') {
            out.output = value || '';
            if (consumesNext) i += 1;
        } else if (key === 'concurrency') {
            out.concurrency = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'list-models' || key === 'listModels') {
            out.listModels = true;
        } else if (key === 'gate') {
            out.gate = true;
        }
    }

    return out;
}

function avg(values) {
    const nums = values.filter(
        (value) => typeof value === 'number' && Number.isFinite(value),
    );
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function sum(values) {
    return values
        .filter((value) => typeof value === 'number' && Number.isFinite(value))
        .reduce((acc, value) => acc + value, 0);
}

// withmartian/code-review-benchmark's OWN reported aggregate (step3_judge_
// comments.py's final summary table) pools tp/fp/fn across every PR FIRST,
// then divides ONCE — not the mean of each PR's own precision/recall. The
// two are mathematically different (a PR-count-weighted mean vs an
// implicit candidate/golden-count-weighted one) and can diverge. This is
// the number to compare against their published results; recall_mean/
// precision_mean/f1_mean above answer a different question (treat every PR
// equally) and are kept for their own established use (regression gate,
// etc).
function poolMetrics(rows) {
    const tp = sum(rows.map((row) => row.metadata?.tp));
    const fp = sum(rows.map((row) => row.metadata?.fp));
    const fn = sum(rows.map((row) => row.metadata?.fn));
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const f1 =
        recall !== null && precision !== null && recall + precision > 0
            ? (2 * recall * precision) / (recall + precision)
            : null;
    return { tp, fp, fn, recall_pooled: recall, precision_pooled: precision, f1_pooled: f1 };
}

function fmtPct(value) {
    if (value === null || value === undefined) return 'n/a';
    return `${Math.round(value * 100)}%`;
}

function fmtDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
    return `${(ms / 1000).toFixed(1)}s`;
}

function writeJson(file, payload) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

const { evaluateGate } = require('./gate');

function tryParseJson(value) {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/** Saída interna do engine -> entrada de submission pública (evals/scorer/README.md). */
function submissionResultFromOutput(caseId, output, tokenUsage) {
    const parsed = tryParseJson(output) || {};
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const trace = parsed.trace || {};
    const SEV = new Set(['critical', 'high', 'medium', 'low', 'info']);
    const sev = (v) => {
        const x = typeof v === 'string' ? v.toLowerCase().trim() : null;
        return SEV.has(x) ? x : null;
    };
    return {
        caseId,
        findings: findings.map((f) => ({
            path: f.relevantFile ?? f.path ?? null,
            // 0 = "sem linha especifica" na saida de alguns modelos (achado
            // conceitual, ex.: padrao duplicado em outro arquivo, decorator).
            // Linha e 1-indexed, entao 0 nunca e valida — normaliza para null
            // em vez de deixar o schema rejeitar a submission inteira.
            startLine:
                Number.isInteger(f.relevantLinesStart) &&
                f.relevantLinesStart > 0
                    ? f.relevantLinesStart
                    : null,
            endLine:
                Number.isInteger(f.relevantLinesEnd) && f.relevantLinesEnd > 0
                    ? f.relevantLinesEnd
                    : null,
            severity: sev(f.severity),
            ...(f.severity && !sev(f.severity)
                ? { severityRaw: String(f.severity) }
                : {}),
            category: f.label ?? f.category ?? null,
            description: [f.oneSentenceSummary, f.suggestionContent]
                .filter(Boolean)
                .join(' — '),
        })),
        usage: {
            inputTokens: tokenUsage?.prompt ?? tokenUsage?.inputTokens ?? 0,
            outputTokens:
                tokenUsage?.completion ?? tokenUsage?.outputTokens ?? 0,
            reasoningTokens: trace.usage?.reasoningTokens ?? null,
            cacheReadTokens: trace.usage?.cacheReadTokens ?? null,
        },
        trace: {
            finishReason: trace.finishReason ?? null,
            steps: typeof trace.steps === 'number' ? trace.steps : null,
            replayCalls:
                typeof trace.replayCalls === 'number'
                    ? trace.replayCalls
                    : null,
            unexpectedToolCalls: Array.isArray(trace.unexpectedToolCalls)
                ? trace.unexpectedToolCalls.length
                : 0,
        },
    };
}

function runMetaOf(args) {
    return {
        harness: { name: 'kodus', version: process.env.KODUS_VERSION || 'dev' },
        model: {
            // id publico = modelo real; sufixo (@sub, @nvidia) e so roteamento
            id:
                (TIER0[args.model] &&
                    (TIER0[args.model].codexModel ||
                        TIER0[args.model].doModel)) ||
                args.model,
            provider:
                (TIER0[args.model] && TIER0[args.model].provider) || 'unknown',
            accessPath:
                TIER0[args.model]?.provider === 'codex_subscription'
                    ? 'subscription'
                    : 'api',
        },
        executionMode: 'replay',
        // heavy = passadas de resample ativadas. Eixo de regime: não comparar
        // entrada heavy com entrada normal sem rotular.
        heavy: process.env.RECALL_HEAVY === '1',
        // RECALL_REASONING_EFFORT ja injeta o effort de verdade na chamada
        // (ver withReasoningEffort em agent-provider.js); sem isto o artefato
        // registrava 'vendor-default' mesmo quando o run era em thinking high.
        reasoning: process.env.RECALL_REASONING_EFFORT
            ? {
                  config: 'explicit',
                  effortRequested: process.env.RECALL_REASONING_EFFORT,
              }
            : { config: 'vendor-default', effortRequested: null },
        runAt: new Date().toISOString(),
    };
}

function traceSummaryFromOutput(output) {
    const parsed = tryParseJson(output);
    const trace = parsed?.trace || {};
    const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
    const toolCounts = {};
    for (const call of toolCalls) {
        const tool = call.tool || call.toolName || 'unknown';
        toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    }

    return {
        steps: trace.steps ?? null,
        finishReason: trace.finishReason ?? null,
        source: trace.source ?? null,
        toolCounts,
        coverage: trace.coverage ?? null,
        anomalies: trace.anomalies ?? null,
        verification: trace.verification ?? null,
    };
}

function providerConfigFor(modelId) {
    if (!TIER0[modelId]) {
        throw new Error(
            `unknown tier0 model '${modelId}' (known: ${Object.keys(TIER0).join(', ')})`,
        );
    }

    return {
        label: `${modelId}-finder-recall`,
        provider: 'tier0',
        model: modelId,
    };
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.listModels) {
        for (const model of defaultMatrix()) console.log(model);
        return;
    }

    // --no-judge: run the finder and SAVE its findings, score nothing. The finder
    // is the expensive half (~$3.5 a night) and a dead judge key used to throw it
    // away — the scoring exception escaped runOneCase before the submission was
    // pushed, so a night that paid for 30 finder runs kept 3. The saved submission
    // is what rejudge.js (or any external judge) re-scores afterwards. It is never
    // a measurement: the run exits 2 with the reason.
    const NO_JUDGE = !!args.noJudge;
    const {
        loadJudgeKey,
        JUDGE_MODEL,
        providerFor,
        matchComment,
    } = require('./recall-judge');
    if (!NO_JUDGE && !loadJudgeKey()) {
        const error = `Missing judge key for ${JUDGE_MODEL} (${providerFor(JUDGE_MODEL)}): set JUDGE_API_KEY.`;
        console.error(error);
        // Still write a result, so the report says what was missing instead of
        // "crashed before writing its result".
        writeJson(
            args.output ||
                path.join(
                    RESULTS_DIR,
                    `finder-recall-${args.model.replace(/[^\w.-]+/g, '-')}.json`,
                ),
            {
                model: args.model,
                cases: 0,
                infraFailures: 0,
                error,
                metrics: {},
                rows: [],
                gate: { status: 'off' },
            },
        );
        process.exit(2);
    }

    if (args.all) process.env.RECALL_ALL = '1';
    else delete process.env.RECALL_ALL;

    if (args.set) process.env.RECALL_SET = args.set;
    else delete process.env.RECALL_SET;

    if (args.cases) process.env.RECALL_CASES = args.cases;
    else delete process.env.RECALL_CASES;

    if (args.threshold !== '') {
        process.env.RECALL_THRESHOLD = String(args.threshold);
    }

    process.env.RECALL_MODEL = args.model;

    // The presence check above passed once while holding the FINDER's Fireworks
    // key — applyModelEnv writes it over API_OPEN_AI_API_KEY — and the 401 only
    // surfaced after 30 paid finder runs. Presence is not validity: spend one
    // judge call before spending the finder.
    if (!NO_JUDGE) {
        try {
            await matchComment(
                loadJudgeKey(),
                'a null pointer when the map is read concurrently',
                'possible NPE: the map is read without synchronisation',
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            console.error(
                `judge preflight failed for ${JUDGE_MODEL} (${providerFor(JUDGE_MODEL)}): ${reason.slice(0, 300)}\n` +
                    'Not measured, and no finder run was paid for. Set JUDGE_API_KEY, or use --no-judge to save the findings for an external judge.',
            );
            process.exit(2);
        }
    }

    const tests = await buildTests();
    let selectedTests = Number.isFinite(args.limit)
        ? tests.slice(0, args.limit)
        : tests;

    if (!selectedTests.length) {
        console.error('No finder-recall cases selected.');
        process.exit(2);
    }

    const InvestigationAgentProvider = require('./agent-provider');
    const recallAssertion = require('./recall-assertion');
    const provider = new InvestigationAgentProvider({
        config: providerConfigFor(args.model),
    });

    const rows = [];
    let infraFailures = 0;
    let qualityFailures = 0;
    let unscored = 0;
    const startedAt = new Date().toISOString();

    console.log(
        `════ finder-recall · model=${args.model} · set=${args.all ? 'all' : args.cases ? 'custom' : args.set} · cases=${selectedTests.length} · threshold=${process.env.RECALL_THRESHOLD || 0} ════`,
    );

    const submissionResults = [];
    // O checkpoint deriva do --output, nao do modelo: duas rodadas do MESMO
    // modelo em paralelo (braços de A/B) escreviam no mesmo arquivo e se
    // sobrescreviam. A submission final ja usava --output; o checkpoint nao,
    // entao um recover pegaria casos misturados dos dois braços sem aviso.
    const checkpointBase = args.output
        ? path.basename(String(args.output)).replace(/\.json$/, '')
        : `finder-recall-${args.model.replace(/[^\w.-]+/g, '-')}`;
    const checkpointPath = path.join(
        RESULTS_DIR,
        `${checkpointBase}.submission.partial.json`,
    );

    const runOneCase = async (test) => {
        const caseId = test.vars?.caseId || test.description || 'unknown-case';
        const prompt = JSON.stringify(test.vars || {});
        // Wall-clock time for the whole case (agent loop + all recall passes),
        // not just token cost — the two don't always track together (a pass
        // that waits on rate limits burns time without burning tokens).
        const startedAt = Date.now();
        let apiResult;

        try {
            // eslint-disable-next-line no-await-in-loop
            apiResult = await provider.callApi(prompt, { vars: test.vars }, {});
        } catch (error) {
            infraFailures += 1;
            const row = {
                caseId,
                status: 'infra',
                reason: error instanceof Error ? error.message : String(error),
                durationMs: Date.now() - startedAt,
            };
            rows.push(row);
            console.log(`INFRA ${caseId} ${row.reason.slice(0, 180)}`);
            return;
        }

        if (!apiResult?.output) {
            infraFailures += 1;
            const row = {
                caseId,
                status: 'infra',
                reason: apiResult?.error || 'provider returned no output',
                metadata: apiResult?.metadata,
                durationMs: Date.now() - startedAt,
            };
            rows.push(row);
            console.log(`INFRA ${caseId} ${row.reason.slice(0, 180)}`);
            return;
        }

        if (NO_JUDGE) {
            unscored += 1;
            // Carry the trace summary even unscored: it holds the verify funnel
            // (beforeCount / afterCount / droppedByVerifier and each decision's
            // parseMode), which needs no judge and is the only way this mode can
            // say whether the pipeline still works rather than just that it ran.
            rows.push({
                caseId,
                status: 'unscored',
                reason: 'judge skipped (--no-judge): findings saved for an external judge',
                traceSummary: traceSummaryFromOutput(apiResult.output),
            });
            // Log what was SAVED, read off the saved record itself. Deriving the
            // count separately is how this line came to print 0 while the
            // submission held 4: the engine's output is a JSON string, not an
            // object, so a second bespoke read of it silently found nothing.
            const saved = submissionResultFromOutput(
                caseId,
                apiResult.output,
                apiResult.tokenUsage,
            );
            submissionResults.push(saved);
            writeJson(checkpointPath, {
                benchmarkVersion: `${args.all ? 'all50' : args.cases ? 'custom' : args.set}-v1`,
                run: runMetaOf(args),
                partial: true,
                completedCases: submissionResults.length,
                results: submissionResults,
            });
            console.log(`SAVED  ${caseId} findings=${saved.findings.length}`);
            return;
        }

        // RECALL_DUMP=<dir>: grava a saida crua do agente por caso, ANTES do
        // judge rodar. A revisao em si (a parte cara: minutos de agent loop
        // real) ja terminou aqui — se o judge quebrar (rate limit, credito,
        // parse), essa saida nao pode se perder junto, senao a unica forma de
        // reavaliar e pagar a revisao inteira de novo. Sem isso a submission
        // so guarda findings + trace, entao um modelo que devolve ZERO
        // findings e indistinguivel de um parsing que falhou.
        if (process.env.RECALL_DUMP) {
            try {
                fs.mkdirSync(process.env.RECALL_DUMP, { recursive: true });
                fs.writeFileSync(
                    path.join(process.env.RECALL_DUMP, `${caseId}.raw.txt`),
                    typeof apiResult.output === 'string'
                        ? apiResult.output
                        : JSON.stringify(apiResult.output, null, 2),
                );
            } catch (e) {
                console.warn(`[dump] ${caseId}: ${e.message}`);
            }
        }

        let assertion;
        try {
            // eslint-disable-next-line no-await-in-loop
            assertion = await recallAssertion(apiResult.output, {
                vars: test.vars,
            });
        } catch (error) {
            infraFailures += 1;
            const row = {
                caseId,
                status: 'infra',
                reason: `judge failed (review output was saved${process.env.RECALL_DUMP ? ' to RECALL_DUMP' : ''}, only scoring is lost): ${error instanceof Error ? error.message : String(error)}`,
                durationMs: Date.now() - startedAt,
            };
            rows.push(row);
            console.log(`INFRA ${caseId} ${row.reason.slice(0, 180)}`);
            return;
        }
        const metadata = assertion.metadata || {};
        const status = assertion.pass ? 'pass' : 'fail';
        if (!assertion.pass) qualityFailures += 1;

        const durationMs = Date.now() - startedAt;
        rows.push({
            caseId,
            status,
            score: assertion.score,
            reason: assertion.reason,
            metadata,
            tokenUsage: apiResult.tokenUsage,
            traceSummary: traceSummaryFromOutput(apiResult.output),
            durationMs,
        });

        submissionResults.push(
            submissionResultFromOutput(
                caseId,
                apiResult.output,
                apiResult.tokenUsage,
            ),
        );
        // checkpoint por caso: passada longa que morre não pode perder o que já foi pago
        writeJson(checkpointPath, {
            benchmarkVersion: `${args.all ? 'all50' : args.cases ? 'custom' : args.set}-v1`,
            run: runMetaOf(args),
            partial: true,
            completedCases: submissionResults.length,
            results: submissionResults,
        });

        console.log(
            `${status.toUpperCase().padEnd(6)} ${caseId} recall=${fmtPct(metadata.recall ?? assertion.score)} precision=${fmtPct(metadata.precision)} fidelity=${fmtPct(metadata.hitRate)} findings=${metadata.findings ?? 'n/a'} duration=${fmtDuration(durationMs)}`,
        );
    };

    // Pool: casos são independentes (replay determinístico próprio), então
    // sequencial era só desperdício de relógio.
    const concurrency = Math.max(
        1,
        Math.min(Number(args.concurrency) || 4, selectedTests.length),
    );
    console.log(
        `(concorrência: ${concurrency}${process.env.RECALL_HEAVY === '1' ? ' · HEAVY' : ''})\n`,
    );
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const idx = cursor++;
            if (idx >= selectedTests.length) return;
            try {
                await runOneCase(selectedTests[idx]);
            } catch (error) {
                // Reaches here when scoring throws (e.g. the judge's key is
                // rejected). It used to be counted without a word, so CI showed
                // "INFRA failure(s): 8" for weeks and nobody could say why.
                infraFailures += 1;
                const row = {
                    caseId: selectedTests[idx]?.vars?.caseId || `idx-${idx}`,
                    status: 'infra',
                    reason:
                        error instanceof Error ? error.message : String(error),
                };
                rows.push(row);
                console.log(`INFRA ${row.caseId} ${row.reason.slice(0, 300)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    // pool devolve fora de ordem: reordena pela ordem do dataset (artefato estável)
    const orderOf = new Map(
        selectedTests.map((t, i) => [
            t.vars?.caseId || t.description || `idx-${i}`,
            i,
        ]),
    );
    const byOrder = (a, b) =>
        (orderOf.get(a.caseId) ?? 1e9) - (orderOf.get(b.caseId) ?? 1e9);
    rows.sort(byOrder);
    submissionResults.sort(byOrder);

    const tokens = rows.reduce(
        (sum, row) => ({
            prompt: sum.prompt + (row.tokenUsage?.prompt || 0),
            completion: sum.completion + (row.tokenUsage?.completion || 0),
        }),
        { prompt: 0, completion: 0 },
    );
    const infraBudget = Math.ceil(rows.length * 0.05);
    // Not measured = no recall on the row, whatever the status says. A case
    // whose output failed to parse is written as a 'fail' with empty metadata
    // and never counted as infra, so counting only infra rows would let a run
    // that scored a handful of PRs report itself as a full one.
    const unmeasured = rows.filter(
        (row) => !Number.isFinite(row.metadata?.recall),
    ).length;
    const summary = {
        model: args.model,
        startedAt,
        finishedAt: new Date().toISOString(),
        tokens,
        cases: rows.length,
        passed: rows.filter((row) => row.status === 'pass').length,
        failed: qualityFailures,
        infraFailures,
        unmeasured,
        infraBudget,
        metrics: {
            recall_mean: avg(rows.map((row) => row.metadata?.recall)),
            precision_mean: avg(rows.map((row) => row.metadata?.precision)),
            f1_mean: avg(rows.map((row) => row.metadata?.f1)),
            fair_recall_mean: avg(rows.map((row) => row.metadata?.fairRecall)),
            fidelity_mean: avg(rows.map((row) => row.metadata?.hitRate)),
            // Wall-clock, not token cost — includes every case (pass AND infra
            // failure both spent real time before erroring out).
            duration_mean_ms: avg(rows.map((row) => row.durationMs)),
            // Martian-parity pooled aggregate — see poolMetrics's doc.
            ...poolMetrics(rows),
        },
        rows,
    };

    const setName = args.all ? 'all' : args.cases ? 'custom' : args.set;
    const gate = args.gate
        ? evaluateGate(summary, rows, args.model, setName)
        : { status: 'off' };
    summary.gate = gate;

    const outputPath =
        args.output ||
        path.join(
            RESULTS_DIR,
            `finder-recall-${args.model.replace(/[^\w.-]+/g, '-')}.json`,
        );
    writeJson(outputPath, summary);

    const submissionPath = outputPath.replace(/\.json$/, '.submission.json');
    writeJson(submissionPath, {
        benchmarkVersion: `${args.all ? 'all50' : args.cases ? 'custom' : args.set}-v1`,
        run: runMetaOf(args),
        results: submissionResults,
    });
    try {
        fs.unlinkSync(checkpointPath);
    } catch {}

    console.log('\n════ finder-recall summary ════');
    console.log(`model: ${summary.model}`);
    console.log(`cases: ${summary.cases}`);
    console.log(`recall_mean: ${fmtPct(summary.metrics.recall_mean)}`);
    console.log(`precision_mean: ${fmtPct(summary.metrics.precision_mean)}`);
    console.log(`f1_mean: ${fmtPct(summary.metrics.f1_mean)}`);
    console.log(`fidelity_mean: ${fmtPct(summary.metrics.fidelity_mean)}`);
    // Martian-parity — pools tp/fp/fn across every PR before dividing once;
    // this is the number comparable to their published benchmark results.
    console.log(`recall_pooled (martian-parity): ${fmtPct(summary.metrics.recall_pooled)}`);
    console.log(`precision_pooled (martian-parity): ${fmtPct(summary.metrics.precision_pooled)}`);
    console.log(`f1_pooled (martian-parity): ${fmtPct(summary.metrics.f1_pooled)}`);
    console.log(`duration_mean: ${fmtDuration(summary.metrics.duration_mean_ms)}`);
    console.log(`artifact: ${path.relative(process.cwd(), outputPath)}`);
    if (NO_JUDGE) {
        // The percentages above are empty by construction, not a result. Say so
        // next to them: a 0% that looks like a measurement is how a dead judge
        // went unseen for weeks.
        console.log(
            `\n--no-judge: ${unscored} case(s) ran the finder and were NOT scored.` +
                `\nfindings saved: ${path.relative(process.cwd(), outputPath).replace(/\.json$/, '.submission.json')}` +
                `\nthe percentages above are empty by construction — score them with evals/investigation/rejudge.js or an external judge.`,
        );
    }

    // Langfuse ships spans in batches; the SDK's own flush rides on Node's
    // `beforeExit`, which never fires on the process.exit paths below (infra
    // failure, gate failure) and is not worth trusting on the normal one
    // either. Flushing here, explicitly, is what makes a finished run's trace
    // actually reach the project.
    try {
        const lf = require(
            path.join(__dirname, '../../libs/core/log/langfuse.ts'),
        );
        await lf.flushLangfuse();
    } catch (err) {
        console.warn(`langfuse flush: ${String(err).slice(0, 120)}`);
    }

    // The PR debugger, built from the dump this run just wrote. Generated here
    // rather than by hand because a diagnostic nobody remembers to run is a
    // diagnostic nobody reads — and the three measurement bugs this harness hid
    // were each found by reading a dump after the fact.
    if (process.env.RECALL_DUMP) {
        const debuggerPath = outputPath.replace(/\.json$/, '') + '.debug.html';
        try {
            const { execFileSync } = require('child_process');
            execFileSync(
                process.execPath,
                [
                    path.join(__dirname, 'build-pr-debugger.js'),
                    `--dump=${process.env.RECALL_DUMP}`,
                    `--results=${path.basename(outputPath)}`,
                    `--out=${debuggerPath}`,
                ],
                { stdio: 'pipe', timeout: 300_000 },
            );
            console.log(
                `debugger: ${path.relative(process.cwd(), debuggerPath)}`,
            );
        } catch (err) {
            // Never fail a finished run over its own report.
            console.warn(
                `debugger: falhou (${String(err.message || err).slice(0, 140)})`,
            );
        }
    }

    if (gate.status === 'pass' || gate.status === 'fail') {
        console.log('\n════ model floor gate (targets.json) ════');
        for (const check of gate.checks) {
            const actual =
                typeof check.actual === 'number'
                    ? check.actual.toFixed(3)
                    : 'n/a';
            console.log(
                `${check.pass ? 'OK  ' : 'FAIL'}  ${check.name}: ${actual} (floor ${check.floor})`,
            );
        }
    } else if (gate.status === 'skipped') {
        console.log(`\ngate skipped: ${gate.reason}`);
    }

    // A flaky provider call on one PR out of thirty should not cost the whole
    // night: at 1% per-case flake, refusing any infra failure throws away a
    // quarter of the nights. Up to 5% of the set may go unmeasured; the run
    // then gates on the PRs that did measure and says how many it had.
    if (unmeasured > infraBudget) {
        console.error(
            `\n${unmeasured} PR(s) not measured (${infraFailures} infra${unscored ? `, ${unscored} unscored by --no-judge` : ''}), budget ${infraBudget}`,
        );
        process.exit(2);
    }
    if (unmeasured > 0)
        console.log(
            `\n${unmeasured} PR(s) not measured, within the budget of ${infraBudget}: gating on the ${rows.length - unmeasured} that were.`,
        );

    // --gate asked for a verdict against the floors; a gate that couldn't run
    // (no targets, wrong judge) is not a pass. Exit 2 so the night is not
    // recorded as green and never becomes the next night's baseline.
    if (args.gate && gate.status === 'skipped') {
        console.error(`\nGate requested but not evaluated: ${gate.reason}`);
        process.exit(2);
    }

    // With --gate the run mean decides (per-PR results are noise); without it,
    // per-case failures (RECALL_THRESHOLD, unparsed output) fail the run.
    if (!args.gate && qualityFailures > 0) {
        console.error(
            `\nFinder recall gate failed in ${qualityFailures} case(s).`,
        );
        process.exit(1);
    }

    if (gate.status === 'fail') {
        console.error(
            '\nModel floor gate FAILED (run mean below targets.json floor).',
        );
        process.exit(1);
    }
}

// Exit explicitly: the engine can leave a handle open after the last case, and
// a finished run that never exits holds its CI job until the timeout.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
