#!/usr/bin/env node
/**
 * Self-written references: the model under test writes, per item, what a
 * correct fix must meet, before and without seeing any enrichment answer.
 * It plays Astra's role with what production has: one call, the frozen
 * enrichment input, no repository, no gold description, no example fix.
 *
 *   RECALL_MODEL=<tier0 id> node evals/enrichment/refine.js [--par=6]
 *     -> evals/enrichment/dataset/references-self/<model>.json
 *
 * judge.js --refs=<that file> grades with these references instead of Astra's.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { createModel } = require('../investigation/agent-provider-1821');

const MODEL = process.env.RECALL_MODEL;
const PAR = Number((process.argv.find((a) => a.startsWith('--par=')) || '--par=6').split('=')[1]);
const OUT_DIR = path.join(__dirname, 'dataset', 'references-self');
const OUT = path.join(OUT_DIR, `${MODEL.replace(/[^\w.-]+/g, '_')}.json`);
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
    let i = 0, fail = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < todo.length) {
            const it = todo[i++];
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const r = REF.parse(await LLM.run({ system: SYSTEM, user: prompt(it), schema: REF, prebuiltModel: model, runName: 'eval-enrich-refine' }));
                    done.set(it.issueId, { issueId: it.issueId, ...r });
                    break;
                } catch (e) {
                    if (attempt === 2) { fail++; console.error(it.issueId, String(e?.message || e).slice(0, 200)); }
                }
            }
        }
    }));
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, items: [...done.values()] }, null, 1));
    console.log(`${MODEL}: ${done.size}/${items.length} references, failed ${fail}`);
    process.exit(fail ? 1 : 0);
})();
