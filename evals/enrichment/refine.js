#!/usr/bin/env node
/**
 * Self-written references: the model under test writes, per item, what a
 * correct fix must meet, before and without seeing any enrichment answer.
 * It plays Astra's role with what production has: the frozen enrichment
 * input, no gold description, no example fix; one call, or the repository with --tools.
 *
 *   RECALL_MODEL=<tier0 id> node evals/enrichment/refine.js [--par=6] [--tools]
 *     -> evals/enrichment/dataset/references-self/<model>[-tools].json
 *
 * --tools adds the finder's read tools (grep, readFile, listDir, findFile)
 * over a worktree at the PR head, up to 12 steps, as Astra had the repository.
 *
 * judge.js --refs=<that file> grades with these references instead of Astra's.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { z } = require('zod');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { createModel } = require('../investigation/agent-provider-1821');
const lib = (p) => require(path.join(__dirname, '../../libs', p));
const { buildFinderToolRegistry } = lib('code-review/infrastructure/agents/adapters/finder-tools.adapter.ts');
const { InMemoryToolRegistry } = lib('agent-harness/infrastructure/tools/in-memory-tool-registry.ts');
const { AiSdkAgentRunner } = lib('agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { BudgetPolicy } = lib('agent-harness/infrastructure/policies/budget.policy.ts');
const { ForceFinalizePolicy } = lib('agent-harness/infrastructure/policies/force-finalize.policy.ts');
const { createAgentRunContext } = lib('llm/agent-run-context.ts');
const { extractLastJsonObjectWith } = lib('llm/structured-output-repair.ts');
const { comandosSandboxLocal } = require('../shared/local-sandbox');

const MODEL = process.env.RECALL_MODEL;
const PAR = Number((process.argv.find((a) => a.startsWith('--par=')) || '--par=6').split('=')[1]);
const OUT_DIR = path.join(__dirname, 'dataset', 'references-self');
const TOOLS = process.argv.includes('--tools');
const OUT = path.join(OUT_DIR, `${MODEL.replace(/[^\w.-]+/g, '_')}${TOOLS ? '-tools' : ''}.json`);
const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));
const READ_TOOLS = new Set(['grep', 'readFile', 'listDir', 'findFile']);
const DONE = 'submitReference';
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset/items.json'), 'utf8')).items;

const REF = z.object({
    defectStatement: z.string(),
    obligations: z.array(z.string()),
    notes: z.string(),
});
const SYSTEM = `You prepare the grading reference for one code-review finding. A later step will propose replacement code for EXACTLY the cited lines, and a grader will check it against what you write here. You do not write a fix.

Return:
- defectStatement: one or two sentences, the defect in concrete terms (what is wrong, where, what breaks). Correct the finding if the shown code says otherwise.
- obligations: 1-4 short, checkable behavioral requirements a correct fix must meet: what must change and what must be preserved (existing behavior, edge cases, callers). Do not prescribe one implementation when several are valid.
- notes: anything a grader must know (alternative valid fixes, traps, parts of the finding that are overstated). Short.`;
const WITH_TOOLS = `

You can read the repository at the pull request head with the read tools. Use them to find what the shown code does not tell you: callers, the types and helpers the cited code uses, other places with the same defect, cases a fix must keep working. Then call ${DONE} with defectStatement, obligations and notes.`;
const REF_JSON = {
    type: 'object',
    additionalProperties: false,
    required: ['defectStatement', 'obligations', 'notes'],
    properties: { defectStatement: { type: 'string' }, obligations: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
};

const worktrees = new Map();
function worktree(caseId) {
    if (!worktrees.has(caseId)) {
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'refine-wt-')), 'wt');
        execFileSync('git', ['-C', REPOS[caseId].repo, 'worktree', 'add', '--detach', dir, REPOS[caseId].head], { stdio: 'ignore' });
        worktrees.set(caseId, dir);
    }
    return worktrees.get(caseId);
}

async function withTools(it, model) {
    const { registry } = buildFinderToolRegistry({ remoteCommands: comandosSandboxLocal(worktree(it.caseId)) });
    const tools = new InMemoryToolRegistry([
        ...registry.list().filter((t) => READ_TOOLS.has(t.name)),
        { name: DONE, description: 'Submit the grading reference and end.', inputSchema: REF_JSON, execute: async () => ({ output: 'submitted' }) },
    ]);
    const spec = {
        id: 'refiner', runName: 'eval-enrich-refine', phase: 'enrich', systemPrompt: SYSTEM + WITH_TOOLS, tools,
        policies: [new BudgetPolicy(), new ForceFinalizePolicy({ doneToolName: DONE })], maxSteps: 12, resultToolName: DONE,
    };
    const { ctx, cleanup } = createAgentRunContext({ runId: `refine:${it.issueId}` });
    try {
        const state = await new AiSdkAgentRunner(undefined, { prebuiltModel: model }).run(spec, { prompt: prompt(it) }, ctx);
        const steps = state.steps.length;
        for (let k = state.artifacts.length - 1; k >= 0; k--) {
            const a = state.artifacts[k];
            if (a.type === DONE && REF.safeParse(a.payload).success) return { ...REF.parse(a.payload), steps };
        }
        const text = state.steps[state.steps.length - 1]?.message.content;
        const json = typeof text === 'string' ? extractLastJsonObjectWith(text, ['obligations']) : null;
        return { ...REF.parse(json), steps };
    } finally {
        cleanup();
    }
}

const prompt = (it) => [
    `<Finding>\nlabel: ${it.finding.label}\nfile: ${it.finding.relevantFile}\ncited lines: ${it.finding.relevantLinesStart}-${it.finding.relevantLinesEnd}\ntext: ${it.finding.suggestionContent}\n</Finding>`,
    `<CitedCode>\n${it.deterministic.existingCode || '(none)'}\n</CitedCode>`,
    `<FileWindow lines="${it.context.windowLines.join('-')}">\n${it.context.window || '(none)'}\n</FileWindow>`,
    `<FileDiff>\n${it.context.filePatch || '(none)'}\n</FileDiff>`,
].join('\n\n');

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).items : [];
    const done = new Map(prev.map((r) => [r.issueId, r]));
    const model = await createModel({ provider: 'tier0' });
    const todo = items.filter((it) => !done.has(it.issueId));
    const save = () => fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, tools: TOOLS, items: [...done.values()] }, null, 1));
    let fail = 0;
    async function one(it) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const r = TOOLS ? await withTools(it, model) : REF.parse(await LLM.run({ system: SYSTEM, user: prompt(it), schema: REF, prebuiltModel: model, runName: 'eval-enrich-refine' }));
                done.set(it.issueId, { issueId: it.issueId, ...r });
                return;
            } catch (e) {
                if (attempt === 2) { fail++; console.error(it.issueId, String(e?.message || e).slice(0, 200)); }
            }
        }
    }
    async function pool(list) {
        let i = 0;
        await Promise.all(Array.from({ length: PAR }, async () => { while (i < list.length) await one(list[i++]); }));
    }
    if (!TOOLS) await pool(todo);
    else {
        // One PR at a time: its worktree is removed before the next one is created.
        const byCase = new Map();
        for (const it of todo) (byCase.get(it.caseId) || byCase.set(it.caseId, []).get(it.caseId)).push(it);
        for (const [c, list] of byCase) {
            try {
                await pool(list);
            } finally {
                const dir = worktrees.get(c);
                if (dir) {
                    try { execFileSync('git', ['-C', REPOS[c].repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch {}
                    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
                    worktrees.delete(c);
                }
            }
            save();
            console.log(`${c}: ${done.size}/${items.length}`);
        }
    }
    for (const [c, dir] of worktrees) {
        try { execFileSync('git', ['-C', REPOS[c].repo, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch {}
    }
    save();
    console.log(`${MODEL}: ${done.size}/${items.length} references, failed ${fail}`);
    process.exit(fail ? 1 : 0);
})();
