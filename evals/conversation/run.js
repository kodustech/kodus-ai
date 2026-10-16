#!/usr/bin/env node
// conversation: a developer answers a Kody comment in a PR thread, and the
// conversation agent (ConversationAgentProvider, the class production runs)
// replies. Checks the reply against what the code says (cases.js), through the
// judge asking whether the reply asserts it (assertsClaim,
// evals/investigation/recall-judge.js), that Kody acted on nothing nobody asked
// for (no `act` decision, nothing written to the org's stores), and its
// language.
//
//   node evals/conversation/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N] [--show]
//
// --show  prints each reply, to read what the judge read; --show=prompt also the prompt
//
// Each case runs as its own organization with a connected GitHub, as
// production wires one (evals/shared/kodus-mcp.js): no BYOK config (its slot is
// the eval's model), its team's language, and the Kodus MCP connection the
// mcp-manager gives it, served in this process by production's MCP server over
// in-memory stores and the PR's GitHub (evals/shared/github-rest.js). The
// sandbox is production's local one, fetched from a git remote that carries
// the base branch and the PR head (evals/shared/pr-remote.js). The agent's
// tools are what production gives it: the Kodus MCP tools, the sandbox's, and
// the decision tool.
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { languageOf } = require('../format/checks');
const { assertsClaim, loadJudgeKey, JUDGE_MODEL } = require('../investigation/recall-judge');
const { startKodusMcp } = require('../shared/kodus-mcp');
const { CASES } = require('./cases');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const cases = CASES.slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
applyModelEnv(MODEL);
countTokens();
const { runThread } = require('../shared/pr-thread');

async function runCase(c, i, judgeKey, kodus) {
    const { reply, decision, prompt, written } = await runThread(c, { index: i, kodus, id: c.id });
    if (args.show === 'prompt') console.log(`\n── ${c.id} prompt\n${prompt}\n`);
    if (args.show) console.log(`\n── ${c.id} — ${c.reply}\n${reply}\n`);
    const right = await assertsClaim(judgeKey, c.golden, reply);
    const want = c.language === 'pt-BR' ? 'pt' : 'en';
    const lang = languageOf(reply);
    const detail = [
        { what: `says: ${c.golden.slice(0, 120)}${right ? '' : ` — replied: ${String(reply).replace(/\s+/g, ' ').slice(0, 160)}`}`, ok: right },
        { what: `acts on nothing nobody asked for (intent: ${decision?.intent ?? 'none'}, writes: ${written.count})`, ok: decision?.intent !== 'act' && written.count === 0 },
        { what: `replies in ${c.language} (read as ${lang})`, ok: ['unknown', want].includes(lang) },
    ];
    // The whole reply, for whoever reads the verdict after the judge.
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail, reply: reply.slice(0, 4000) };
}

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`not measured: no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const kodus = await startKodusMcp();
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                results[i] = { id: c.id, checks: c.checks, ...(await runCase(c, i, judgeKey, kodus)) };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));
    await kodus.close();

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'conversation',
        question: evalQuestion('evals/conversation'),
        model: MODEL,
        judge: JUDGE_MODEL,
        runs: 1,
        metric: { name: 'of reply checks right', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results) {
        const failed = (r.detail || []).filter((d) => !d.ok);
        console.log(`  ${r.unmeasured ? 'N/A ' : failed.length ? 'MISS' : 'ok  '} ${r.id}${failed.length ? `: ${failed.map((d) => d.what).join(' · ')}` : ''}`);
    }
    console.log(`conversation: ${hits}/${total} reply checks right (judge ${JUDGE_MODEL}) · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.error(`not measured: no floor for ${MODEL} in evals/conversation/targets.json, so --gate cannot judge it`);
        return 2;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/conversation/targets.json`);
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
