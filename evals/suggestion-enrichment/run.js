#!/usr/bin/env node
// suggestion-enrichment: production's AgentReviewStage.enrichFinderSuggestions on
// the 150 findings of the enrichment dataset (evals/enrichment/dataset), each with
// its file at the PR head, scored on what ships: the title after the stage
// resolves it and the fix after the publication gate (README.md).
//
//   node evals/suggestion-enrichment/run.js [--model=<id>] [--judge=<id>] [--set=controlled|full] [--cases=<id,id>] [--limit=N] [--concurrency=N] [--gate] [--output=<file>]
//
// --set    controlled and full are the same 150 findings: one set, cheap enough to run whole
// --judge  the model that grades the answers (default claude-opus-5.5@api, the judge the floors hold under)
//
// Exit: 0 pass, 1 below a floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { refusal } = require('../funnel/stage-run');
const { casesOf } = require('./catalog');
const { titleFormatOk, VERDICT, SYSTEM, judgePrompt } = require('./judge');

const DEFAULT_JUDGE = 'claude-opus-5.5@api';
const METRICS = ['fix', 'noCode', 'title'];

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );

const headFiles = () => require('./dataset/head-files.json').files;

// The suggestion as the stage gets it from the lean finder, and its file as
// FetchChangedFilesStage leaves it: the content at the PR head and the diff.
const suggestionOf = (item) => ({
    label: item.finding.label,
    relevantFile: item.finding.relevantFile,
    relevantLinesStart: item.finding.relevantLinesStart,
    relevantLinesEnd: item.finding.relevantLinesEnd,
    suggestionContent: item.finding.suggestionContent,
});
const changedFileOf = (item, files) => ({
    filename: item.finding.relevantFile,
    fileContent: files[`${item.caseId}|${item.finding.relevantFile}`],
    patch: item.context.filePatch,
});

// What the enrichment step leaves, as the comment ships it: the title the stage
// resolves (fullSuggestionTitle) and the fix the publication gate keeps (checkFix).
function shipped(out) {
    const { fullSuggestionTitle } = require('../../libs/common/utils/codeManagement/suggestion-title.ts');
    const { checkFix } = require('../../libs/code-review/infrastructure/agents/engine/is-usable-fix.ts');
    const title = fullSuggestionTitle({ summary: out.oneSentenceSummary, body: out.suggestionContent });
    const code = out.improvedCode && checkFix(out.existingCode, out.improvedCode, out.language) === null ? out.improvedCode : null;
    return { title, code, wroteTitle: !!out.oneSentenceSummary };
}

async function enrichCase(env, item) {
    const { teamContext, buildAgentReviewStage } = require('../shared/review-stage');
    const { context, codeManagement } = await teamContext(env);
    const stage = buildAgentReviewStage({ permissionService: env.permissionService, codeManagement });
    const [out] = await stage.enrichFinderSuggestions([suggestionOf(item)], context, [changedFileOf(item, headFiles())]);
    return shipped(out);
}

async function grade(judgeSlot, c, answer) {
    const { LLM } = require('../../libs/llm/llm.ts');
    const ans = { oneSentenceSummary: answer.title, fixStatus: answer.code ? 'local' : 'none', improvedCode: answer.code || '' };
    const verdict = await LLM.run({
        system: SYSTEM,
        user: judgePrompt(c.item, c.ref, ans),
        schema: VERDICT,
        byokConfig: judgeSlot,
        runName: 'eval-enrich-judge',
    });
    return VERDICT.parse(verdict);
}

function scoreCase(c, answer, verdict) {
    const fixed = !!answer.code && verdict.fix === 'PASS';
    const title = titleFormatOk(answer.title) && verdict.titleNamesProblem;
    // Two checks per finding: its code (a fix, or none) and its title.
    const codeRight = c.mustFix ? fixed : !answer.code;
    return {
        hits: Number(codeRight) + Number(title),
        total: 2,
        mustFix: c.mustFix,
        fix: c.mustFix ? fixed : null,
        noCode: c.mustFix ? null : !answer.code,
        title,
        titleFormatOk: titleFormatOk(answer.title),
        titleNamesProblem: verdict.titleNamesProblem,
        wroteTitle: answer.wroteTitle,
        shipsCode: !!answer.code,
        judge: { fix: verdict.fix, fixReason: verdict.fixReason, titleReason: verdict.titleReason },
        shippedTitle: answer.title,
    };
}

// Of the cases each metric covers (fix: the fixable ones, noCode: the others, title: all), the share right.
function metricsOf(results) {
    const rows = results.filter((r) => !r.unmeasured);
    return Object.fromEntries(
        METRICS.map((m) => {
            const of = rows.filter((r) => r[m] !== null && r[m] !== undefined);
            const right = of.filter((r) => r[m]).length;
            return [m, { right, total: of.length, value: of.length ? right / of.length : null }];
        }),
    );
}

function belowFloors(metrics, target) {
    return METRICS.filter((m) => Number.isFinite(target[m]?.floor) && metrics[m].value !== null && metrics[m].value < target[m].floor).map(
        (m) => `${m} ${(metrics[m].value * 100).toFixed(1)}% < ${target[m].floor * 100}%`,
    );
}

// The org's routed model for `modelId`, as the stage reads it.
async function slotFor(internals, modelId) {
    const previous = process.env.RECALL_MODEL;
    process.env.RECALL_MODEL = modelId;
    try {
        const route = internals.resolveRoute({ provider: 'tier0', model: modelId });
        const permissionService = internals.evalPermissionService(route.storedConfig);
        return { route, permissionService };
    } finally {
        process.env.RECALL_MODEL = previous;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const MODEL = args.model || 'deepseek-v4-flash@fireworks';
    const JUDGE = args.judge || DEFAULT_JUDGE;
    const SET = args.set || 'controlled';
    if (!['controlled', 'full'].includes(SET)) {
        console.error(`unknown --set=${SET}: controlled or full`);
        return 2;
    }
    const targets = require('./targets.json');
    const TARGET = (targets.sets[SET]?.models || {})[MODEL] || {};
    // libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
    if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
    const { internals } = require('../investigation/agent-provider');
    countTokens();
    let judgeSlot;
    try {
        const judge = await slotFor(internals, JUDGE);
        const { teamContext } = require('../shared/review-stage');
        judgeSlot = (await teamContext({ team: {}, ...judge })).context.codeReviewConfig?.byokConfig;
    } catch (error) {
        console.error(`not measured: judge ${JUDGE}: ${error.message}`);
        return 2;
    }
    let step;
    try {
        step = await slotFor(internals, MODEL);
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        return 2;
    }
    process.env.RECALL_MODEL = MODEL;

    const only = args.cases ? new Set(String(args.cases).split(',')) : null;
    const cases = casesOf()
        .filter((c) => !only || only.has(c.id))
        .slice(0, args.limit ? Number(args.limit) : undefined);

    const results = new Array(cases.length);
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                // eslint-disable-next-line no-await-in-loop
                const { result: answer, errors } = await withCallErrors(() => enrichCase({ team: {}, ...step }, c.item));
                const refused = refusal(errors);
                if (refused) throw new Error(`enrichment call refused: ${String(refused.message || refused).slice(0, 160)}`);
                // eslint-disable-next-line no-await-in-loop
                const verdict = await grade(judgeSlot, c, answer);
                results[i] = { id: c.id, checks: c.checks, ...scoreCase(c, answer, verdict) };
            } catch (error) {
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const metrics = metricsOf(results);
    const errored = results.filter((r) => r.unmeasured).length;
    const result = {
        eval: 'suggestion-enrichment',
        question: evalQuestion('evals/suggestion-enrichment'),
        model: MODEL,
        judge: JUDGE,
        set: SET,
        runs: 1,
        metric: { name: 'of the fixable findings, a fix the judge passes', value: metrics.fix.value, floor: TARGET.fix?.floor ?? null, baseline: TARGET.fix?.observed ?? null },
        metrics,
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: results.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(
        `suggestion-enrichment: ${METRICS.map((m) => `${m} ${metrics[m].right}/${metrics[m].total}`).join(' · ')} · judge ${JUDGE} · ${errored} of ${results.length} findings did not measure`,
    );
    if (errored > results.length * 0.05) {
        console.error(`not measured: ${errored} of ${results.length} findings failed (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (!args.gate) return 0;
    if (!METRICS.some((m) => Number.isFinite(TARGET[m]?.floor))) {
        console.log(`ungated: no floor for ${MODEL} in evals/suggestion-enrichment/targets.json`);
        return 0;
    }
    if (TARGET.judge && TARGET.judge !== JUDGE) {
        console.log(`ungated: the floors hold under judge ${TARGET.judge}, this run used ${JUDGE}`);
        return 0;
    }
    const below = belowFloors(metrics, TARGET);
    if (below.length) {
        console.error(`GATE FAILED: ${below.join('; ')} (evals/suggestion-enrichment/targets.json)`);
        return 1;
    }
    return 0;
}

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(error);
            process.exit(2);
        });
}

module.exports = { shipped, scoreCase, metricsOf, belowFloors, suggestionOf, changedFileOf };
