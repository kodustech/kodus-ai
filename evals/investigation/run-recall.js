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

function parseArgs(argv) {
    const out = {
        model: process.env.FINDER_MODEL || process.env.RECALL_MODEL || 'gpt-5.4',
        all: process.env.RECALL_ALL === '1',
        set: process.env.RECALL_SET || 'pr',
        cases: process.env.RECALL_CASES || '',
        limit: null,
        threshold:
            process.env.FINDER_RECALL_THRESHOLD ||
            process.env.RECALL_THRESHOLD ||
            '',
        output: '',
        listModels: false,
        gate: process.env.RECALL_GATE === '1',
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;

        const key = m[1];
        const inlineValue = m[2];
        const value = inlineValue ?? argv[i + 1];
        const consumesNext = inlineValue === undefined && value && !String(value).startsWith('--');

        if (key === 'model') {
            out.model = value || out.model;
            if (consumesNext) i += 1;
        } else if (key === 'all') {
            out.all = true;
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
        } else if (key === 'list-models') {
            out.listModels = true;
        } else if (key === 'gate') {
            out.gate = true;
        }
    }

    return out;
}

function avg(values) {
    const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function fmtPct(value) {
    if (value === null || value === undefined) return 'n/a';
    return `${Math.round(value * 100)}%`;
}

function writeJson(file, payload) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

/**
 * Absolute per-model floors (evals/investigation/targets.json). Gate is on the
 * RUN MEAN across the case set — never per-PR (per-PR recall noise is ±20pp;
 * single PRs scoring 0 is normal). Besides recallFloor, two low-noise collapse
 * detectors trip when the engine breaks rather than when recall wobbles:
 * minMeanFindings (prompt lost / findings not parsed) and minMeanToolCalls
 * (tools dead / loop not engaging).
 */
function evaluateGate(summary, rows, model) {
    let targets;
    try {
        targets = require('./targets.json');
    } catch (err) {
        // Missing file → skip the gate. A malformed file must fail loudly
        // rather than silently disabling the gate.
        if (err.code === 'MODULE_NOT_FOUND') {
            return { status: 'skipped', reason: 'targets.json missing' };
        }
        throw err;
    }
    const target = targets.models?.[model];
    if (!target) {
        return { status: 'skipped', reason: `no target for model ${model}` };
    }

    const meanFindings = avg(
        rows.map((row) => {
            const md = row.metadata || {};
            const tp = md.tpFindings;
            const fp = md.fpFindings;
            if (typeof tp !== 'number' || typeof fp !== 'number') return null;
            return tp + fp;
        }),
    );
    const meanToolCalls = avg(rows.map((row) => row.metadata?.totalCalls));

    const checks = [
        {
            name: 'recall_mean',
            actual: summary.metrics.recall_mean,
            floor: target.recallFloor,
        },
        { name: 'mean_findings', actual: meanFindings, floor: target.minMeanFindings },
        { name: 'mean_tool_calls', actual: meanToolCalls, floor: target.minMeanToolCalls },
    ].map((check) => ({
        ...check,
        pass:
            typeof check.actual === 'number' &&
            typeof check.floor === 'number' &&
            check.actual >= check.floor,
    }));

    return {
        status: checks.every((check) => check.pass) ? 'pass' : 'fail',
        checks,
    };
}

function tryParseJson(value) {
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
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

    const { loadJudgeKey } = require('./recall-judge');
    if (!loadJudgeKey()) {
        console.error(
            'Missing judge key: set API_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY, or BYOK_ANTHROPIC_API_KEY.',
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

    const tests = await buildTests();
    const selectedTests = Number.isFinite(args.limit)
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

    console.log(
        `════ finder-recall · model=${args.model} · set=${args.all ? 'all' : args.cases ? 'custom' : args.set} · cases=${selectedTests.length} · threshold=${process.env.RECALL_THRESHOLD || 0} ════`,
    );

    for (const test of selectedTests) {
        const caseId = test.vars?.caseId || test.description || 'unknown-case';
        const prompt = JSON.stringify(test.vars || {});
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
            };
            rows.push(row);
            console.log(`INFRA ${caseId} ${row.reason.slice(0, 180)}`);
            continue;
        }

        if (!apiResult?.output) {
            infraFailures += 1;
            const row = {
                caseId,
                status: 'infra',
                reason: apiResult?.error || 'provider returned no output',
                metadata: apiResult?.metadata,
            };
            rows.push(row);
            console.log(`INFRA ${caseId} ${row.reason.slice(0, 180)}`);
            continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const assertion = await recallAssertion(apiResult.output, {
            vars: test.vars,
        });
        const metadata = assertion.metadata || {};
        const status = assertion.pass ? 'pass' : 'fail';
        if (!assertion.pass) qualityFailures += 1;

        rows.push({
            caseId,
            status,
            score: assertion.score,
            reason: assertion.reason,
            metadata,
            tokenUsage: apiResult.tokenUsage,
            traceSummary: traceSummaryFromOutput(apiResult.output),
        });

        console.log(
            `${status.toUpperCase().padEnd(6)} ${caseId} recall=${fmtPct(metadata.recall ?? assertion.score)} precision=${fmtPct(metadata.precision)} fidelity=${fmtPct(metadata.hitRate)} findings=${metadata.findings ?? 'n/a'}`,
        );
    }

    const summary = {
        model: args.model,
        cases: rows.length,
        passed: rows.filter((row) => row.status === 'pass').length,
        failed: qualityFailures,
        infraFailures,
        metrics: {
            recall_mean: avg(rows.map((row) => row.metadata?.recall)),
            precision_mean: avg(rows.map((row) => row.metadata?.precision)),
            f1_mean: avg(rows.map((row) => row.metadata?.f1)),
            fair_recall_mean: avg(rows.map((row) => row.metadata?.fairRecall)),
            fidelity_mean: avg(rows.map((row) => row.metadata?.hitRate)),
        },
        rows,
    };

    const gate = args.gate
        ? evaluateGate(summary, rows, args.model)
        : { status: 'off' };
    summary.gate = gate;

    const outputPath =
        args.output ||
        path.join(RESULTS_DIR, `finder-recall-${args.model.replace(/[^\w.-]+/g, '-')}.json`);
    writeJson(outputPath, summary);

    console.log('\n════ finder-recall summary ════');
    console.log(`model: ${summary.model}`);
    console.log(`cases: ${summary.cases}`);
    console.log(`recall_mean: ${fmtPct(summary.metrics.recall_mean)}`);
    console.log(`precision_mean: ${fmtPct(summary.metrics.precision_mean)}`);
    console.log(`fidelity_mean: ${fmtPct(summary.metrics.fidelity_mean)}`);
    console.log(`artifact: ${path.relative(process.cwd(), outputPath)}`);

    if (gate.status === 'pass' || gate.status === 'fail') {
        console.log('\n════ model floor gate (targets.json) ════');
        for (const check of gate.checks) {
            const actual =
                typeof check.actual === 'number' ? check.actual.toFixed(3) : 'n/a';
            console.log(
                `${check.pass ? 'OK  ' : 'FAIL'}  ${check.name}: ${actual} (floor ${check.floor})`,
            );
        }
    } else if (gate.status === 'skipped') {
        console.log(`\ngate skipped: ${gate.reason}`);
    }

    if (infraFailures > 0) {
        console.error(`\nINFRA failure(s): ${infraFailures}`);
        process.exit(2);
    }

    if (qualityFailures > 0) {
        console.error(`\nFinder recall gate failed in ${qualityFailures} case(s).`);
        process.exit(1);
    }

    if (gate.status === 'fail') {
        console.error('\nModel floor gate FAILED (run mean below targets.json floor).');
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
