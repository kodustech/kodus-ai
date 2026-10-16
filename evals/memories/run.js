#!/usr/bin/env node
// memories: runs the real finder (evals/investigation/agent-provider.js: the
// production prompt, finder and verify) on small pull requests whose team has a
// memory (cases.js), and checks that the review follows it: quiet where the
// memory says the code is intended, a finding where it says the code is wrong
// or where a real bug falls outside what it covers.
//
//   node evals/memories/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--concurrency=N] [--no-memories]
//
// --no-memories  the same cases with no memory, to see which ones the memory decides
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { createPatch } = require('diff');
const { registerTs } = require('../shared/eval-kit');
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
const cases = CASES.slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
process.env.RECALL_MODEL = MODEL;
registerTs();
const { convertToUnifiedDiffWithLineNumbers } = require('../../libs/common/utils/patch.ts');
const Provider = require('../investigation/agent-provider');

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');

// The PR's changed files as the review stage renders them.
function changedFiles(c) {
    return Object.entries(c.before).map(([filename, before]) => {
        const patch = createPatch(filename, before ?? '', c.repo[filename] ?? '').split('\n').slice(4).join('\n');
        return { filename, patchWithLinesStr: convertToUnifiedDiffWithLineNumbers(patch, { filename }) };
    });
}

function caseVars(c) {
    return {
        caseId: `memories-${c.id}`,
        prTitle: c.prTitle,
        prBody: c.prBody,
        repositoryFullName: 'eval/memories',
        reviewMode: 'normal',
        maxSteps: 12,
        changedFiles: changedFiles(c),
        repoFiles: c.repo,
        memoryRules: args['no-memories'] ? [] : c.memories.map((m) => ({ ...m, type: 'memory' })),
    };
}

const lineOf = (c, file, at) => (at ? c.repo[file].split('\n').findIndex((l) => l.includes(at)) + 1 : null);
const textOf = (f) => `${f.oneSentenceSummary || ''} ${f.suggestionContent || ''}`;
const touches = (f, file, line, within, about) =>
    norm(f.relevantFile) === file &&
    about.test(textOf(f)) &&
    (line == null || (Number(f.relevantLinesStart ?? 0) - within <= line && line <= Number(f.relevantLinesEnd ?? f.relevantLinesStart ?? 0) + within));

function score(c, findings) {
    return c.expect.map((e) => {
        const file = e.flag || e.quiet;
        const line = lineOf(c, file, e.at);
        if (e.at && !line) throw new Error(`${c.id}: '${e.at}' is not in ${file}`);
        const hit = findings.filter((f) => touches(f, file, line, e.within ?? 3, e.about));
        const where = `${file}${line ? `:${line}` : ''}`;
        if (e.flag) return { what: `flags ${where}`, ok: hit.length > 0 };
        const said = hit.map((f) => textOf(f).trim().slice(0, 80)).join('; ');
        return { what: `quiet on ${where}${hit.length ? ` — said: ${said}` : ''}`, ok: hit.length === 0 };
    });
}

async function main() {
    const provider = new Provider({ config: { label: `memories-${MODEL}`, provider: 'tier0', model: MODEL } });
    const results = new Array(cases.length);
    const tokens = { in: 0, out: 0, cacheRead: 0 };
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            const vars = caseVars(c);
            try {
                const r = await provider.callApi(JSON.stringify(vars), { vars }, {});
                if (!r.output) throw new Error(String(r.error || 'the finder returned no output').slice(0, 200));
                tokens.in += r.tokenUsage?.prompt ?? 0;
                tokens.out += r.tokenUsage?.completion ?? 0;
                tokens.cacheRead += r.tokenUsage?.cached ?? 0;
                const detail = score(c, JSON.parse(r.output).findings || []);
                results[i] = { id: c.id, checks: c.checks, hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));

    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'memories',
        question: evalQuestion('evals/memories'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of memory cases the review got right', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens,
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    for (const r of results) console.log(`  ${r.hits === r.total && !r.unmeasured ? 'ok  ' : 'MISS'} ${r.id}${r.detail ? `: ${r.detail.filter((d) => !d.ok).map((d) => d.what).join('; ')}` : ''}`);
    console.log(`memories: ${hits}/${total} right${args['no-memories'] ? ' (no memories given)' : ''} · ${errored} of ${cases.length} cases did not measure`);
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
        console.error(`not measured: no floor for ${MODEL} in evals/memories/targets.json, so --gate cannot judge it`);
        return 2;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/memories/targets.json`);
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
