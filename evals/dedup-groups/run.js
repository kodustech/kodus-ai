#!/usr/bin/env node
// dedup-groups: production's AgentReviewStage.dedupSuggestionStreams on the
// suggestions one finder pool wrote on 30 PRs, scored against the duplicate
// gold v2 of #1821 (cases/<pool>.json): which suggestions it joined and which
// it should have (README.md).
//
//   node evals/dedup-groups/run.js [--model=<id>] [--set=controlled|full] [--pool=<pool>] [--embedder=platform|none] [--cases=<id,id>] [--limit=N] [--concurrency=N] [--gate] [--output=<file>]
//
// --set   controlled (default): the pool of the nightly model; full: every pool
// --pool  one pool instead (deepseek-v4.1-flash, gpt-6.1-sol, sonnet-5.5, muse-spark-1.2)
// --embedder  platform (default): the platform's OpenAI key, as cloud; none: no
//         embedder, as a self-hosted install without that key (shared/embedder.js)
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { datasetFor } = require('../funnel/known-bugs');
const { refusal } = require('../funnel/stage-run');
const { parseEmbedder, applyEmbedder, watchEmbeddings } = require('../shared/embedder');

const POOLS = ['deepseek-v4.1-flash', 'gpt-6.1-sol', 'sonnet-5.5', 'muse-spark-1.2'];
const CONTROLLED_POOL = 'deepseek-v4.1-flash';

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );

// Pairs of suggestion ids that share a group, as "a|b" with a < b.
function pairsOf(groups) {
    const pairs = new Set();
    for (const group of groups) {
        const members = [...new Set(group)].sort();
        for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.add(`${members[i]}|${members[j]}`);
    }
    return pairs;
}

// One case's score: the gold's pairs the dedup joined, the pairs it joined that
// the gold keeps apart, and what it kept.
function scoreCase(testCase, out) {
    const gold = pairsOf(testCase.groups);
    const idOf = (k) => testCase.suggestions[k].id;
    const merged = pairsOf(out.groups.map((g) => g.filter((k) => Number.isInteger(k)).map(idOf)));
    const text = (id) => testCase.suggestions.find((s) => s.id === id).suggestionContent.replace(/\s+/g, ' ').slice(0, 70);
    const detail = [...gold].map((p) => {
        const [a, b] = p.split('|');
        return { what: `${a} + ${b}: ${text(a)}`, ok: merged.has(p) };
    });
    const falseMerges = [...merged].filter((p) => !gold.has(p));
    return {
        hits: detail.filter((d) => d.ok).length,
        total: detail.length,
        detail,
        falseMerges: falseMerges.length,
        falseMergePairs: falseMerges,
        merged: merged.size,
        kept: out.kept.length,
        goldGroups: testCase.groups.length,
        suggestions: testCase.suggestions.length,
        dedupStatus: out.status,
    };
}

// The suggestion as the stage gets it from the finder: the lean output's fields.
const findingOf = (s) => ({
    id: s.id,
    label: s.label,
    relevantFile: s.relevantFile,
    relevantLinesStart: s.relevantLinesStart,
    relevantLinesEnd: s.relevantLinesEnd,
    suggestionContent: s.suggestionContent,
});

// The stage built as the review builds it, over the PR's context. The trace's
// summaries are read with the input index each suggestion carries
// (`evalIndex`), so a merged group maps back to the suggestions in it; nothing
// the stage decides changes.
async function dedupCase(env, testCase) {
    const { prepareReview, buildAgentReviewStage } = require('../shared/review-stage');
    const { context, codeManagement, cleanup } = await prepareReview(env);
    try {
        const stage = buildAgentReviewStage({ permissionService: env.permissionService, codeManagement });
        const summarize = stage.summarizeDedupSuggestion;
        stage.summarizeDedupSuggestion = function summarizeWithIndex(s) {
            return { ...summarize.call(this, s), evalIndex: s?.evalIndex };
        };
        const input = testCase.suggestions.map((s, k) => ({ ...findingOf(s), evalIndex: k }));
        const { deduped, dedupTrace } = await stage.dedupSuggestionStreams(input, context.pullRequest.number, context, undefined);
        return {
            kept: deduped.map((s) => s.evalIndex),
            groups: (dedupTrace.groups || []).map((g) => [g.keep?.evalIndex, ...(g.duplicates || []).map((d) => d.evalIndex)]),
            status: dedupTrace.status,
        };
    } finally {
        await cleanup();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const MODEL = args.model || 'deepseek-v4-flash@fireworks';
    const SET = args.set || 'controlled';
    if (!['controlled', 'full'].includes(SET)) {
        console.error(`unknown --set=${SET}: controlled or full`);
        return 2;
    }
    const pools = args.pool ? [String(args.pool)] : SET === 'full' ? POOLS : [CONTROLLED_POOL];
    const unknownPool = pools.find((p) => !POOLS.includes(p));
    if (unknownPool) {
        console.error(`unknown --pool=${unknownPool}: ${POOLS.join(', ')}`);
        return 2;
    }
    let EMBEDDER;
    try {
        EMBEDDER = parseEmbedder(args.embedder);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    const TARGET = (require('./targets.json').sets[SET]?.models || {})[MODEL] || {};
    // libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
    if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
    process.env.RECALL_MODEL = MODEL;
    const { internals } = require('../investigation/agent-provider');
    countTokens();
    const environment = watchEmbeddings(EMBEDDER);
    const route = internals.resolveRoute({ provider: 'tier0', model: MODEL });
    applyEmbedder(EMBEDDER);
    const permissionService = internals.evalPermissionService(route.storedConfig);

    const only = args.cases ? new Set(String(args.cases).split(',')) : null;
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const cases = pools
        .flatMap((pool) => require(path.join(__dirname, 'cases', `${pool}.json`)).cases)
        .filter((c) => !only || only.has(c.id) || only.has(c.pr))
        .slice(0, args.limit ? Number(args.limit) : undefined);

    const results = new Array(cases.length);
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            const pairs = pairsOf(c.groups).size;
            const checks = `Joins the ${pairs} duplicate pair${pairs === 1 ? '' : 's'} the gold finds among the ${c.suggestions.length} suggestions on ${c.id}, and merges nothing the gold keeps apart`;
            try {
                const vars = datasetFor(c.pr);
                const env = { pr: internals.prOf(vars), team: internals.teamOf(vars), route, permissionService };
                // eslint-disable-next-line no-await-in-loop
                const { result: out, errors } = await withCallErrors(() => dedupCase(env, c));
                const refused = refusal(errors);
                if (refused) throw new Error(`dedup call refused: ${String(refused.message || refused).slice(0, 160)}`);
                results[i] = { id: c.id, checks, ...scoreCase(c, out) };
            } catch (error) {
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const measured = results.filter((r) => !r.unmeasured);
    const sum = (k) => measured.reduce((n, r) => n + (r[k] || 0), 0);
    const hits = sum('hits');
    const total = sum('total');
    const merged = sum('merged');
    const errored = results.length - measured.length;
    const result = {
        eval: 'dedup-groups',
        question: evalQuestion('evals/dedup-groups'),
        model: MODEL,
        set: SET,
        pools,
        runs: 1,
        metric: { name: 'of the gold duplicate pairs, joined', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        metrics: {
            pairRecall: total ? hits / total : null,
            pairPrecision: merged ? hits / merged : null,
            falseMerges: sum('falseMerges'),
            commentsKept: sum('kept'),
            goldGroups: sum('goldGroups'),
            suggestions: sum('suggestions'),
        },
        environment: environment(),
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: results.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of measured.filter((x) => x.hits < x.total || x.falseMerges)) {
        console.log(`  ${r.id}: ${r.hits}/${r.total} pairs joined, ${r.falseMerges} false merges, ${r.kept} kept of ${r.suggestions} (gold ${r.goldGroups})`);
    }
    const m = result.metrics;
    console.log(
        `dedup-groups: ${hits}/${total} gold pairs joined · ${m.falseMerges} false merges (pair precision ${m.pairPrecision === null ? 'n/a' : `${(m.pairPrecision * 100).toFixed(1)}%`}) · ${m.commentsKept} comments kept, gold ${m.goldGroups} groups, of ${m.suggestions} · embedder ${result.environment.embedder} · ${errored} of ${results.length} cases did not measure`,
    );
    if (errored > results.length * 0.05) {
        console.error(`not measured: ${errored} of ${results.length} cases failed (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor !== null && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/dedup-groups/targets.json`);
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

module.exports = { pairsOf, scoreCase };
