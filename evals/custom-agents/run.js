#!/usr/bin/env node
// custom-agents: production's review stage (evals/shared/review-stage.js:
// config through CodeBaseConfigService, FetchChangedFilesStage, the local
// sandbox over the PR's head, AgentReviewStage with the team's custom agents,
// their verify and every step after it) on small pull requests whose team set
// up custom agents (cases.js). It checks what the stage ships from each agent,
// and which files the review handed it, against the feature's properties
// (README.md).
//
//   node evals/custom-agents/run.js [--model=<id>] [--gate] [--output=<result.json>] [--cases=<id,...>] [--concurrency=N]
//
// Exit: 0 pass, 1 below a floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { CASES } = require('./cases');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const picked = args.cases
    ? CASES.filter((c) => String(args.cases).split(',').includes(c.id))
    : CASES;

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
// How a case reaches production's review: the finder eval's own conversion of
// a case into the platform's PR and the team's saved config (the path its
// --team-config takes), and the org's model route.
const { teamOf, prOf, resolveRoute, evalPermissionService } =
    require('../investigation/agent-provider').internals;
const { reviewPullRequest } = require('../shared/review-stage');
// Tokens and time of every model call, read like billing (evals/shared/eval-kit.js).
// After the review stage, so its TypeScript hook is the one loaded.
const { countTokens, tokensUsed } = require('../shared/eval-kit');

countTokens();

const LIBS = path.join(__dirname, '../../libs');
const { getDefaultKodusConfigFile } = require(
    path.join(LIBS, 'common/utils/validateCodeReviewConfigFile.ts'),
);
const { customAgentSlug } = require(
    path.join(
        LIBS,
        'core/infrastructure/config/types/general/codeReview.type.ts',
    ),
);

const norm = (f) =>
    String(f || '')
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '');
const agentsOf = (c) => [c.team.agent, ...(c.team.others || [])];

// What the team saved (codeReviewConfig.configs): its agents, production's
// default ignorePaths plus its own, and the built-in categories off, so the
// agents are the only reviewers and what ships is theirs (a configuration
// production supports; the generalist's findings would only add dedup).
function teamConfig(c) {
    const defaults = getDefaultKodusConfigFile();
    return {
        customAgents: agentsOf(c),
        reviewOptions: {
            ...(defaults.reviewOptions || {}),
            bug: false,
            security: false,
            performance: false,
        },
        ...(c.team.ignore?.length
            ? {
                  ignorePaths: [
                      ...(defaults.ignorePaths || []),
                      ...c.team.ignore,
                  ],
              }
            : {}),
    };
}

// The PR as the platform holds it: the repository at its base and at its head.
function caseVars(c) {
    const repoBase = { ...c.repo };
    const repoFiles = { ...c.repo };
    for (const [file, before] of Object.entries(c.before)) {
        if (before === null) delete repoBase[file];
        else repoBase[file] = before;
        if (!(file in c.repo)) repoFiles[file] = null;
    }
    return {
        caseId: `custom-agents-${c.id}`,
        prTitle: c.prTitle,
        prBody: c.prBody,
        repositoryFullName: 'eval/custom-agents',
        reviewMode: 'normal',
        repoBase,
        repoFiles,
    };
}

// A loop that ran and failed (the provider, a key) measured the failure.
function loopFailure(result) {
    if (!result || typeof result !== 'object')
        return 'agent loop returned no result';
    if (result.finishReason === 'error')
        return 'agent loop finished with error';
    if (!Number(result.steps || 0) && !Number(result.usage?.totalTokens || 0))
        return 'agent loop produced zero steps and zero tokens';
    return null;
}

/** One case through production's review: what it shipped, and each agent loop it ran with its files. */
async function review(c, route) {
    const vars = caseVars(c);
    const out = await reviewPullRequest({
        pr: prOf(vars),
        team: teamOf(vars, teamConfig(c)),
        route,
        permissionService: evalPermissionService(route.storedConfig),
    });
    if (out.skipped)
        throw new Error(`production skipped the review: ${out.skipped}`);
    const failure = out.context?.lastReviewError;
    if (failure)
        throw new Error(
            `production review failed: ${failure.category} ${String(failure.providerMessage || failure.friendlyMessage || '').slice(0, 200)}`,
        );
    // No loop is a measured outcome here (an agent with no file in scope, or
    // switched off, runs none); a loop that failed is not.
    const failed = out.loops.map((l) => loopFailure(l.result)).filter(Boolean);
    if (failed.length) throw new Error(failed[0]);
    return {
        shipped: out.shipped,
        loops: out.loops.map((l) => ({
            agent: l.params.agentName,
            files: (l.params.changedFiles || []).map((f) => norm(f.filename)),
        })),
    };
}

const lineOf = (c, file, at) =>
    at ? c.repo[file].split('\n').findIndex((l) => l.includes(at)) + 1 : null;
const textOf = (f) =>
    `${f.oneSentenceSummary || ''} ${f.suggestionContent || ''}`;
const touches = (f, file, line, within, about) =>
    norm(f.relevantFile) === file &&
    (!about || about.test(textOf(f))) &&
    (line == null ||
        (Number(f.relevantLinesStart ?? 0) - within <= line &&
            line <=
                Number(f.relevantLinesEnd ?? f.relevantLinesStart ?? 0) +
                    within));

/** What the review handed an agent (a `dispatch` expectation). Its loops carry its slug in their run name. */
function scoreDispatch(c, e, { shipped, loops }) {
    const agent = agentsOf(c).find((a) => a.id === e.dispatch);
    if (!agent) throw new Error(`${c.id}: no agent ${e.dispatch} in the team`);
    const own = loops.filter(
        (l) => l.agent === `kodus-custom-agent-${customAgentSlug(agent.name)}`,
    );
    const files = new Set(own.flatMap((l) => l.files));
    if (e.runs === false) {
        const posted = shipped.filter(
            (f) => f.customAgent?.id === e.dispatch,
        ).length;
        return {
            property: e.property,
            what: `${e.property} ${e.dispatch} does not run${own.length || posted ? ` — ran ${own.length} loop(s), posted ${posted}` : ''}`,
            ok: !own.length && !posted,
        };
    }
    if (e.gets) {
        return {
            property: e.property,
            what: `${e.property} ${e.dispatch} is handed ${e.gets}${files.has(e.gets) ? '' : ` — got: ${[...files].join(', ') || 'no loop'}`}`,
            ok: files.has(e.gets),
        };
    }
    // `never` holds only for an agent that ran: one that did not proves nothing.
    return {
        property: e.property,
        what: `${e.property} ${e.dispatch} is never handed ${e.never}${own.length ? '' : ' — it did not run'}`,
        ok: own.length > 0 && !files.has(e.never),
    };
}

/** Each expectation of a case against what its agents shipped and were handed. */
function score(c, outcome) {
    const own = outcome.shipped.filter(
        (f) => f.customAgent?.id === c.team.agent.id,
    );
    return c.expect.map((e) => {
        if (e.dispatch) return scoreDispatch(c, e, outcome);
        const file = e.flag || e.quiet;
        const line = lineOf(c, file, e.at);
        if (e.at && !line)
            throw new Error(`${c.id}: '${e.at}' is not in ${file}`);
        const hit = own.filter((f) =>
            touches(f, file, line, e.within ?? 3, e.about),
        );
        const where = `${file}${line ? `:${line}` : ''}`;
        if (e.flag)
            return {
                property: e.property,
                what: `${e.property} flags ${where}`,
                ok: hit.length > 0,
            };
        const said = hit.map((f) => textOf(f).trim().slice(0, 80)).join('; ');
        return {
            property: e.property,
            what: `${e.property} quiet on ${where}${hit.length ? ` — said: ${said}` : ''}`,
            ok: hit.length === 0,
        };
    });
}

/** Right / total per property over the measured cases. */
function byProperty(results) {
    const out = {};
    for (const r of results) {
        for (const d of r.detail || []) {
            out[d.property] = out[d.property] || { hits: 0, total: 0 };
            out[d.property].total += 1;
            if (d.ok) out[d.property].hits += 1;
        }
    }
    return out;
}

async function main() {
    // The org's model, routed as production routes it (a model it has no route for is not measured).
    let route;
    try {
        route = resolveRoute({ provider: 'tier0', model: MODEL });
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        return 2;
    }
    const results = new Array(picked.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < picked.length) {
            const i = next++;
            const c = picked[i];
            try {
                const detail = score(c, await review(c, route));
                results[i] = {
                    id: c.id,
                    checks: c.checks,
                    hits: detail.filter((d) => d.ok).length,
                    total: detail.length,
                    detail,
                };
            } catch (error) {
                errored += 1;
                console.error(
                    `  ${c.id}: ${String(error.message || error).slice(0, 300)}`,
                );
                results[i] = {
                    id: c.id,
                    checks: c.checks,
                    hits: 0,
                    total: 0,
                    unmeasured: true,
                };
            }
        }
    };
    await Promise.all(
        Array.from(
            { length: Math.max(1, Number(args.concurrency) || 4) },
            worker,
        ),
    );

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const floors = TARGET.properties || {};
    const result = {
        eval: 'custom-agents',
        question: evalQuestion('evals/custom-agents'),
        model: MODEL,
        runs: 1,
        metric: {
            name: "of the agents' property checks right",
            value: total ? hits / total : null,
            floor: TARGET.floor ?? null,
            baseline: TARGET.observed ?? null,
        },
        properties: Object.fromEntries(
            Object.entries(byProperty(results)).map(([p, v]) => [
                p,
                {
                    ...v,
                    value: v.total ? v.hits / v.total : null,
                    floor: floors[p] ?? null,
                },
            ]),
        ),
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: picked.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), {
            recursive: true,
        });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results)
        console.log(
            `  ${r.hits === r.total && !r.unmeasured ? 'ok  ' : 'MISS'} ${r.id}${
                r.detail
                    ? `: ${r.detail
                          .filter((d) => !d.ok)
                          .map((d) => d.what)
                          .join('; ')}`
                    : ''
            }`,
        );
    for (const [p, v] of Object.entries(result.properties))
        console.log(
            `  ${p}: ${v.hits}/${v.total}${v.floor != null ? ` (floor ${v.floor})` : ''}`,
        );
    const t = result.tokens;
    console.log(
        `custom-agents: ${hits}/${total} right · ${errored} of ${picked.length} cases did not measure · tokens in=${t.in} out=${t.out} cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite} calls=${t.calls} ms=${t.ms}`,
    );
    if (errored > picked.length * 0.05) {
        console.error(
            `not measured: ${errored} of ${picked.length} cases failed to run (see above)`,
        );
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(
            `not measured: the result breaks the shared shape — ${problems.join('; ')}`,
        );
        return 2;
    }
    if (!args.gate) return 0;
    if (result.metric.floor === null) {
        console.error(
            `not measured: no floor for ${MODEL} in evals/custom-agents/targets.json, so --gate cannot judge it`,
        );
        return 2;
    }
    // Each property holds on its own floor: a break of one property loses only
    // its checks, which the overall share alone would absorb.
    const below = [
        ...(result.metric.value < result.metric.floor
            ? [
                  `overall ${(result.metric.value * 100).toFixed(1)}% < ${(result.metric.floor * 100).toFixed(1)}%`,
              ]
            : []),
        ...Object.entries(result.properties)
            .filter(([, v]) => v.floor != null && v.value < v.floor)
            .map(([p, v]) => `${p} ${v.hits}/${v.total} < ${v.floor}`),
    ];
    if (below.length) {
        console.error(
            `GATE FAILED: ${below.join('; ')} (evals/custom-agents/targets.json)`,
        );
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
