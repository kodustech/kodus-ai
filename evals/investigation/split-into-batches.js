#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Splits one case's diff into N batch-cases, so the eval can measure a review
 * that sees the PR in slices instead of all at once.
 *
 * Why it has to be built here: production splits a PR in `runChunkedReview`,
 * inside BaseCodeReviewAgentProvider — and the eval calls runAgentLoopViaCore
 * directly, so that whole path is bypassed. There is no knob to turn on.
 *
 * Each batch is a full dataset entry: same repo, same head, same goldens, same
 * call graph. Only `changedFilesFull` differs. Pooling is then a union over the
 * batches, which is how production aggregates them too — with one difference
 * worth stating: production runs its final dedup over the pooled set, and here
 * each batch reduces on its own. The pooled recall is therefore an upper bound
 * on what a single reducer would keep.
 *
 * Usage:
 *   node evals/investigation/split-into-batches.js --case=<id> [--budget=20000]
 */
const fs = require('fs');
const path = require('path');
const { chunkFilesByTokenBudget, estimateDiffTokens } =
    require('@libs/code-review/infrastructure/agents/collaborators/context-fit-planner');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const CASE = arg('case');
const BUDGET = Number(arg('budget', '20000'));
if (!CASE) { console.error('need --case=<id>'); process.exit(1); }

const DIR = path.join(__dirname, 'datasets');
const src = fs.readdirSync(DIR).map((f) => path.join(DIR, f))
    .find((f) => { try { return JSON.parse(fs.readFileSync(f,'utf8'))[0].vars.caseId === CASE; } catch { return false; } });
if (!src) { console.error(`caso ${CASE} nao encontrado`); process.exit(1); }

const rec = JSON.parse(fs.readFileSync(src, 'utf8'));
const vars = rec[0].vars;
const files = JSON.parse(vars.changedFilesFull);
const chunks = chunkFilesByTokenBudget(files, BUDGET);

console.log(`${CASE}\n  ${files.length} arquivos · ${estimateDiffTokens(files)} tokens de diff · budget ${BUDGET} → ${chunks.length} batches\n`);

const ids = [];
chunks.forEach((chunk, i) => {
    const id = `${CASE}--b${i + 1}of${chunks.length}`;
    const copy = JSON.parse(JSON.stringify(rec));
    copy[0].vars.caseId = id;
    copy[0].vars.changedFilesFull = JSON.stringify(chunk);
    // `changedFiles` is the six-file cut and is only a fallback; keeping it
    // whole here would let a batch fall back to files outside its own slice.
    copy[0].vars.changedFiles = JSON.stringify(chunk);
    copy[0].description = `${copy[0].description || CASE} [batch ${i + 1}/${chunks.length}]`;
    fs.writeFileSync(path.join(DIR, `${id}.json`), `${JSON.stringify(copy, null, 2)}\n`);
    ids.push(id);
    console.log(`  b${i + 1}: ${String(chunk.length).padStart(3)} arquivos · ${String(estimateDiffTokens(chunk)).padStart(6)} tokens`);
});
console.log(`\n--cases ${ids.join(',')}`);
