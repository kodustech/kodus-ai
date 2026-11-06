#!/usr/bin/env node
// severity-levels: production's AgentReviewStage.reclassifyAndFilterSeverity on
// the 205 suggestions of the severity dataset (evals/severity/dataset), one call
// per PR as the review makes it, scored against the level each suggestion's
// text gets under the defined levels (README.md).
//
//   node evals/severity-levels/run.js [--model=<id>] [--set=controlled|full] [--cases=<id,id>] [--limit=N] [--concurrency=N] [--gate] [--output=<file>]
//
// --set   controlled and full are the same 205 suggestions: one set, cheap enough to run whole
//
// Exit: 0 pass, 1 below a floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { refusal } = require('../funnel/stage-run');
const { casesOf, LEVELS } = require('./catalog');

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );

const isRight = (level, got) => got === level;

// The suggestion as the stage gets it from the lean finder.
const findingOf = (item) => ({
    label: item.label,
    relevantFile: item.finding.relevantFile,
    relevantLinesStart: item.finding.relevantLinesStart,
    relevantLinesEnd: item.finding.relevantLinesEnd,
    suggestionContent: item.finding.suggestionContent,
});

// The stage built as the review builds it, over the team's default config. The
// level of each suggestion is read from what the step keeps and what its
// threshold drops (`allDiscarded`), by the input index it carries (`evalIndex`).
async function rateCase(env, items) {
    const { teamContext, buildAgentReviewStage } = require('../shared/review-stage');
    const { context, codeManagement } = await teamContext(env);
    const stage = buildAgentReviewStage({ permissionService: env.permissionService, codeManagement });
    const discarded = [];
    const kept = await stage.reclassifyAndFilterSeverity(items.map((item, k) => ({ ...findingOf(item), evalIndex: k })), context, discarded);
    const got = new Map([...kept, ...discarded].map((s) => [s.evalIndex, s.severity || null]));
    return items.map((_, k) => got.get(k) ?? null);
}

function scoreCase(testCase, got) {
    const detail = testCase.items.map((item, k) => ({
        what: `${item.issueId} (${item.severity}, rated ${got[k] || 'nothing'}): ${item.finding.suggestionContent.replace(/\s+/g, ' ').slice(0, 90)}`,
        level: item.severity,
        got: got[k],
        ok: isRight(item.severity, got[k]),
    }));
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

// Per defined level: how many of its suggestions got it right.
function perLevel(results) {
    const rows = results.filter((r) => !r.unmeasured).flatMap((r) => r.detail);
    return Object.fromEntries(
        LEVELS.map((level) => {
            const of = rows.filter((d) => d.level === level);
            const right = of.filter((d) => d.ok).length;
            return [level, { right, total: of.length, value: of.length ? right / of.length : null }];
        }),
    );
}

// The floors the run falls below: the share of all suggestions, and each level's.
function belowFloors(result, target) {
    const below = [];
    if (Number.isFinite(target.floor) && result.metric.value < target.floor) below.push(`all ${(result.metric.value * 100).toFixed(1)}% < ${target.floor * 100}%`);
    for (const level of LEVELS) {
        const floor = target.levels?.[level]?.floor;
        const value = result.metrics.levels[level].value;
        if (Number.isFinite(floor) && value !== null && value < floor) below.push(`${level} ${(value * 100).toFixed(1)}% < ${floor * 100}%`);
    }
    return below;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const MODEL = args.model || 'deepseek-v4-flash@fireworks';
    const SET = args.set || 'controlled';
    if (!['controlled', 'full'].includes(SET)) {
        console.error(`unknown --set=${SET}: controlled or full`);
        return 2;
    }
    const TARGET = (require('./targets.json').sets[SET]?.models || {})[MODEL] || {};
    // libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
    if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
    process.env.RECALL_MODEL = MODEL;
    const { internals } = require('../investigation/agent-provider');
    countTokens();
    const route = internals.resolveRoute({ provider: 'tier0', model: MODEL });
    const permissionService = internals.evalPermissionService(route.storedConfig);

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
                const { result: got, errors } = await withCallErrors(() => rateCase({ team: {}, route, permissionService }, c.items));
                const refused = refusal(errors);
                if (refused) throw new Error(`severity call refused: ${String(refused.message || refused).slice(0, 160)}`);
                results[i] = { id: c.id, checks: c.checks, ...scoreCase(c, got) };
            } catch (error) {
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const measured = results.filter((r) => !r.unmeasured);
    const hits = measured.reduce((n, r) => n + r.hits, 0);
    const total = measured.reduce((n, r) => n + r.total, 0);
    const errored = results.length - measured.length;
    const result = {
        eval: 'severity-levels',
        question: evalQuestion('evals/severity-levels'),
        model: MODEL,
        set: SET,
        runs: 1,
        metric: { name: 'of the suggestions, rated at their defined level', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        metrics: { levels: perLevel(results) },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: results.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    const levels = result.metrics.levels;
    console.log(
        `severity-levels: ${hits}/${total} at their level · ${LEVELS.map((l) => `${l} ${levels[l].right}/${levels[l].total}`).join(' · ')} · ${errored} of ${results.length} PRs did not measure`,
    );
    if (errored > results.length * 0.05) {
        console.error(`not measured: ${errored} of ${results.length} PRs failed (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.log(`ungated: no floor for ${MODEL} in evals/severity-levels/targets.json`);
        return 0;
    }
    const below = args.gate ? belowFloors(result, TARGET) : [];
    if (below.length) {
        console.error(`GATE FAILED: ${below.join('; ')} (evals/severity-levels/targets.json)`);
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

module.exports = { isRight, scoreCase, perLevel, belowFloors };
