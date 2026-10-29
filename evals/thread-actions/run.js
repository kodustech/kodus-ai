#!/usr/bin/env node
// thread-actions: in a PR thread, does Kody offer the memory or Kody Rule the
// thread calls for, take it when the developer asks, and write nothing nobody
// asked for? Each thread runs through production's conversation path for an
// org with a connected GitHub (evals/shared/pr-thread.js): the agent, the
// org's Kodus MCP served by production's server and tools over in-memory
// stores, production's sandbox. What it wrote is read from those stores, so a
// write counts only when it went through production's gate and tools.
//
//   node evals/thread-actions/run.js [--model=<id>] [--kind=rule|memory] [--metric=writes|offers] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N] [--show]
//
// --kind    the cases of one action: Kody Rules (stage thread-rule) or memories (thread-memory)
// --metric  what the gate reads (default writes). writes: the memory or rule
//           lands when the developer asks for it (and nothing else does), and
//           nothing is written in any other thread. offers (stages
//           thread-rule-offers, thread-memory-offers): the reply offers the
//           action when the thread calls for it and not otherwise, judged on
//           the reply, over the threads that do not ask Kody to act. The other
//           number is reported beside it (`reported`), never gated.
// --show    prints each reply; --show=prompt also the prompt
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/README.md).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { orgRouteOrExit } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { assertsClaim, loadJudgeKey, JUDGE_MODEL } = require('../investigation/recall-judge');
const { startKodusMcp } = require('../shared/kodus-mcp');
const { CASES, OFFER_CLAIM, kindOf } = require('./cases');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const KIND = args.kind || null;
if (KIND && !['rule', 'memory'].includes(KIND)) {
    console.error(`--kind is rule or memory, not ${KIND}`);
    process.exit(2);
}
const OFFERS = (args.metric || 'writes') === 'offers';
if (!['writes', 'offers'].includes(args.metric || 'writes')) {
    console.error(`--metric is writes or offers, not ${args.metric}`);
    process.exit(2);
}
const TARGETS = require('./targets.json').models || {};
const TARGET = (TARGETS[MODEL] || {})[`${KIND || 'all'}${OFFERS ? '-offers' : ''}`] || {};
const cases = CASES.filter((c) => (!KIND || kindOf(c) === KIND) && (!OFFERS || !c.expect.act)).slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
// The org's model, routed as production routes it (evals/shared/model-route.js).
const ROUTE = orgRouteOrExit(MODEL);
countTokens();
const { runThread, REPOSITORY, orgOf } = require('../shared/pr-thread');
const { buildKodyRuleLink } = require('../../libs/code-review/utils/build-kody-rule-link.ts');

// A case's existing rule as the org stores it, and the comment Kody posted for
// it: a Kody Rules finding whose text links the rule, as the review appends it
// (agent-review.stage.ts: "Kody rule violation: [title](link)").
const DATE = new Date('2026-10-01T12:00:00Z');
function withRule(c, index) {
    if (!c.kodyComment.rule) return { thread: c, rules: [] };
    const seed = c.kodyComment.rule;
    const uuid = crypto.createHash('sha256').update(c.id).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5');
    const rule = {
        uuid,
        type: 'standard',
        origin: 'manual',
        status: 'active',
        repositoryId: REPOSITORY.id,
        examples: [],
        inheritance: { inheritable: true, exclude: [], include: [] },
        createdAt: DATE,
        updatedAt: DATE,
        ...seed,
    };
    const link = buildKodyRuleLink('https://app.kodus.io', uuid, rule, orgOf(index));
    const title = rule.title.replace(/([[\]\\`*_{}()#+\-.!])/g, '\\$1');
    const kodyComment = { ...c.kodyComment, label: 'kody_rules', ruleIds: [uuid], text: `${c.kodyComment.text}\n\nKody rule violation: [${title}](${link})` };
    return { thread: { ...c, kodyComment }, rules: [rule] };
}

const mentionsIn = (r, word) => !word || `${r.title || ''} ${r.rule || ''}`.toLowerCase().includes(word.toLowerCase());

// The rule no longer covers the finding's file: its path stops matching it
// (production's matcher), or its text excludes that directory.
const { fileMatchesRulePath } = require('../../libs/common/utils/kody-rules/file-patterns.ts');
const narrowedOff = (r, file) => {
    const dir = file.split('/')[0];
    return (!!r.path && !fileMatchesRulePath(file, r.path)) || `${r.title || ''} ${r.rule || ''}`.includes(`${dir}/`);
};

// The write the developer asked for, read from the org's stores.
function actedAsAsked(c, written, rules) {
    if (c.kind === 'memory') return written.created.some((r) => r.type === 'memory' && mentionsIn(r, c.mentions));
    if (c.kind === 'rule-create') return written.created.some((r) => r.type !== 'memory' && mentionsIn(r, c.mentions));
    return written.updated.some((r) => r.uuid === rules[0]?.uuid && narrowedOff(r, c.kodyComment.file));
}

async function runCase(c, i, judgeKey, kodus) {
    const { thread, rules } = withRule(c, i);
    const { reply, decision, prompt, written } = await runThread(thread, { index: i, kodus, id: c.id, rules });
    if (args.show === 'prompt') console.log(`\n── ${c.id} prompt\n${prompt}\n`);
    if (args.show) console.log(`\n── ${c.id} — ${c.reply}\n${reply}\n`);
    const writes = `writes: ${written.count}${written.count ? ` (${[...written.created.map((r) => `created ${r.type} "${r.title}"`), ...written.updated.map((r) => `changed "${r.title}"`), ...written.issues.map((r) => `issue "${r.title}"`)].join(', ')})` : ''}`;
    const detail = c.expect.act
        ? [
              { what: `does what the developer asked (${c.kind}${c.mentions ? `, about "${c.mentions}"` : ''}; ${writes})`, ok: actedAsAsked(c, written, rules) },
              { what: `writes nothing else (${writes})`, ok: written.count === 1 },
          ]
        : [{ what: `writes nothing nobody asked for (intent: ${decision?.intent ?? 'none'}, ${writes})`, ok: decision?.intent !== 'act' && written.count === 0 }];
    // Whether the reply offers the action: only where Kody was not asked to act.
    let offer = null;
    if (!c.expect.act) {
        const offered = await assertsClaim(judgeKey, OFFER_CLAIM[c.kind], reply);
        const want = Boolean(c.expect.offer);
        offer = { what: `${want ? 'offers' : 'does not offer'} the ${c.kind} action (intent: ${decision?.intent ?? 'none'}${decision?.tool ? `, ${decision.tool}` : ''})`, ok: offered === want };
    }
    if (OFFERS) return { hits: offer.ok ? 1 : 0, total: 1, detail: [offer], writes: detail, reply: reply.slice(0, 4000) };
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail, offer, reply: reply.slice(0, 4000) };
}

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`not measured: no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const kodus = await startKodusMcp({ storedConfig: ROUTE.storedConfig });
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
    // The checks the gate does not read: the offers, or in offers mode the writes.
    const other = results.flatMap((r) => (OFFERS ? r.writes || [] : r.offer ? [r.offer] : []));
    const otherRight = other.filter((o) => o.ok).length;
    const names = { writes: 'of write checks right', offers: 'of offer checks right' };
    const result = {
        eval: 'thread-actions',
        question: evalQuestion('evals/thread-actions'),
        model: MODEL,
        judge: JUDGE_MODEL,
        kind: `${KIND || 'all'}${OFFERS ? '-offers' : ''}`,
        runs: 1,
        metric: { name: names[OFFERS ? 'offers' : 'writes'], value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        reported: { name: `${names[OFFERS ? 'writes' : 'offers']} (not gated)`, value: other.length ? otherRight / other.length : null, hits: otherRight, total: other.length },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results) {
        const failed = [...(r.detail || []), ...(r.offer ? [r.offer] : []), ...(r.writes || [])].filter((d) => !d.ok);
        console.log(`  ${r.unmeasured ? 'N/A ' : failed.length ? 'MISS' : 'ok  '} ${r.id}${failed.length ? `: ${failed.map((d) => d.what).join(' · ')}` : ''}`);
    }
    const [gated, notGated] = OFFERS ? ['offer', 'write'] : ['write', 'offer'];
    console.log(`thread-actions${KIND ? ` (${KIND})` : ''}: ${hits}/${total} ${gated} checks right · ${notGated} checks ${otherRight}/${other.length} (not gated) · judge ${JUDGE_MODEL} · ${errored} of ${cases.length} cases did not measure`);
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
        console.error(`not measured: no floor for ${MODEL} (${result.kind}) in evals/thread-actions/targets.json, so --gate cannot judge it`);
        return 2;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/thread-actions/targets.json`);
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
