#!/usr/bin/env node
/**
 * Runs production's content enrichment (enrich-content.ts) over the dataset.
 *
 *   RECALL_MODEL=<tier0 id> node evals/enrichment/run.js --variant=oneshot|tools [--split=dev|test|all] [--par=4] [--out=<file>]
 *
 * oneshot: one LLM.run call per finding over the frozen input.
 * tools:   the same input, plus the finder's read tools (grep, readFile,
 *          listDir, findFile) over a worktree at the PR head.
 * Writes one row per item: the answer, time, tokens, steps and tool calls.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const lib = (p) => require(path.join(__dirname, '../../libs', p));
const { enrichOneShot, enrichWithTools } = lib('code-review/infrastructure/agents/engine/enrich-content.ts');
const { buildFinderToolRegistry } = lib('code-review/infrastructure/agents/adapters/finder-tools.adapter.ts');
const { InMemoryToolRegistry } = lib('agent-harness/infrastructure/tools/in-memory-tool-registry.ts');
const { AiSdkAgentRunner } = lib('agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { createAgentRunContext } = lib('llm/agent-run-context.ts');
const { createModel } = require('../investigation/agent-provider-1821');
const { comandosSandboxLocal } = require('../shared/local-sandbox');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const MODEL = process.env.RECALL_MODEL;
const VARIANT = arg('variant', 'oneshot');
const SPLIT = arg('split', 'all');
const PAR = Number(arg('par', 4));
const OUT = arg('out', path.join(__dirname, 'results', `${(MODEL || '').replace(/[^\w.-]+/g, '_')}-${VARIANT}.json`));
const READ_TOOLS = new Set(['grep', 'readFile', 'listDir', 'findFile']);
if (!MODEL || !['oneshot', 'tools'].includes(VARIANT)) {
    console.error('RECALL_MODEL=<id> --variant=oneshot|tools');
    process.exit(2);
}

const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset/items.json'), 'utf8')).items.filter(
    (x) => SPLIT === 'all' || x.split === SPLIT,
).slice(0, Number(arg('limit', 1e9)));

// Token usage of every model call, summed per item.
function withUsage(model, sink) {
    const add = (u) => {
        if (!u) return;
        const n = (v) => (typeof v === 'number' ? v : v?.total ?? 0);
        sink.input += n(u.inputTokens);
        sink.output += n(u.outputTokens);
        sink.cacheRead += u.cachedInputTokens ?? u.inputTokens?.cacheRead ?? 0;
        sink.calls++;
    };
    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === 'doGenerate') return async (o) => { const r = await target.doGenerate(o); add(r.usage); return r; };
            if (prop === 'doStream') {
                return async (o) => {
                    const r = await target.doStream(o);
                    const t = new TransformStream({ transform(part, ctl) { if (part.type === 'finish') add(part.usage); ctl.enqueue(part); } });
                    return { ...r, stream: r.stream.pipeThrough(t) };
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

const worktrees = new Map();
function worktree(caseId) {
    if (!worktrees.has(caseId)) {
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-wt-')), 'wt');
        execFileSync('git', ['-C', REPOS[caseId].repo, 'worktree', 'add', '--detach', dir, REPOS[caseId].head], { stdio: 'ignore' });
        worktrees.set(caseId, dir);
    }
    return worktrees.get(caseId);
}
function cleanup() {
    for (const [c, dir] of worktrees) {
        try { execFileSync('git', ['-C', REPOS[c].repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch {}
    }
}

async function one(it) {
    const input = {
        finding: it.finding,
        existingCode: it.deterministic.existingCode,
        language: it.deterministic.language,
        fileWindow: it.context.window,
        filePatch: it.context.filePatch,
    };
    const usage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
    const model = withUsage(await createModel({ provider: 'tier0' }, it.caseId), usage);
    const t0 = Date.now();
    const row = { issueId: it.issueId, split: it.split };
    try {
        if (VARIANT === 'oneshot') {
            row.result = await enrichOneShot(input, { prebuiltModel: model });
        } else {
            const { registry } = buildFinderToolRegistry({ remoteCommands: comandosSandboxLocal(worktree(it.caseId)) });
            const tools = new InMemoryToolRegistry(registry.list().filter((t) => READ_TOOLS.has(t.name)));
            const runner = new AiSdkAgentRunner(undefined, { prebuiltModel: model });
            const { ctx, cleanup: done } = createAgentRunContext({ runId: `enrich:${it.issueId}` });
            try {
                const { result, state } = await enrichWithTools(input, { runner, tools, ctx });
                row.result = result;
                row.steps = state.steps.length;
                row.toolCalls = state.steps.flatMap((s) => (s.message.toolCalls || []).map((c) => c.name || c.toolName)).filter((n) => n !== 'submitEnrichment');
            } finally {
                done();
            }
        }
    } catch (e) {
        row.error = String(e?.message || e).slice(0, 300);
    }
    row.ms = Date.now() - t0;
    row.usage = usage;
    return row;
}

(async () => {
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).rows : [];
    const done = new Map(prev.filter((r) => r.result && !r.error).map((r) => [r.issueId, r]));
    const todo = items.filter((x) => !done.has(x.issueId));
    // tools: one PR at a time per worker, so a worktree serves all its items.
    todo.sort((a, b) => a.caseId.localeCompare(b.caseId));
    console.log(`${MODEL} ${VARIANT}: ${todo.length} to run, ${done.size} kept`);
    let i = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < todo.length) {
            const it = todo[i++];
            const row = await one(it);
            done.set(it.issueId, row);
            console.log(`${row.error ? 'ERR ' : 'ok  '}${it.issueId} ${row.result?.fixStatus ?? ''} ${row.ms}ms${row.error ? ' ' + row.error : ''}`);
        }
    }));
    cleanup();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const rows = items.map((x) => done.get(x.issueId)).filter(Boolean);
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, variant: VARIANT, split: SPLIT, rows }, null, 1));
    const errs = rows.filter((r) => r.error || !r.result).length;
    console.log(`done: ${rows.length} rows, ${errs} without an answer -> ${OUT}`);
    process.exit(errs > rows.length * 0.05 ? 2 : 0);
})();
