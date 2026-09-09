// What does issue #1826 step 1 COST?
//
// Step 1 puts the whole file into every file shard, so the reviewer can answer
// "is this import used further down" instead of guessing. The benefit is
// measured elsewhere (the negative corpus). This measures the bill, and the
// bill matters more than usual here: we are BYOK, so the extra tokens are spent
// on the customer's own key, on every review, forever.
//
//   node evals/kody-rules/shard-cost-repro.js [--corpus=polyglot-cases-with-content]
//
// Drives the SHIPPED judge and measures the REAL prompt string it builds —
// `runJudge` receives the assembled `user` and simply weighs it. No model call,
// so the number is exact rather than sampled, and free to re-run.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const CORPUS = args.corpus || 'polyglot-cases-with-content';

const { judgeKodyRulesSharded, FILE_CONTENT_BUDGET_CHARS } = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge');
const { estimateTokens } = require('@libs/code-review/infrastructure/adapters/services/utils/token-estimator');

const corpus = require('./' + CORPUS + '.json');

// Two ordinary language-agnostic rules: the point is to weigh the ENVELOPE the
// judge builds, not to model any particular customer's rule set. Agnostic on
// purpose so every file is sharded and nothing is filtered out of the bill.
const RULES = [
    { uuid: 'r1', title: 'No commented-out code', rule: 'Do not leave commented-out code behind. Delete it; version control remembers it.' },
    { uuid: 'r2', title: 'No hardcoded credentials', rule: 'Never hardcode a credential, token or password. Reference an environment variable or the secret store.' },
];

// `estimateTokens` runs the real o200k_base tokenizer, so these are token
// counts, not a chars/N guess — which matters, because the ratio that is close
// on dense code is off by multiples on the repetitive text a whole file
// contains (blank lines, indentation, import blocks).
async function weigh(changedFiles, fileContents) {
    let chars = 0, tokens = 0, shards = 0;
    await judgeKodyRulesSharded({
        changedFiles,
        rules: RULES,
        fileContents,
        runJudge: async ({ user }) => {
            shards++;
            chars += user.length;
            tokens += estimateTokens(user);
            return [];
        },
    });
    return { shards, chars, tokens };
}

const fmt = (n) => n.toLocaleString('en-US');
const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(1) : '0.0');

(async () => {
    const changedFiles = [];
    const contents = new Map();
    let withContent = 0, overBudget = 0;
    for (const c of corpus) {
        for (const f of c.realChangedFiles || []) {
            changedFiles.push({ filename: f.filename, patchWithLinesStr: f.patchWithLinesStr, patch: f.patchWithLinesStr });
            if (typeof f.content === 'string' && f.content.trim()) {
                withContent++;
                if (f.content.length > FILE_CONTENT_BUDGET_CHARS) overBudget++;
                contents.set(f.filename, f.content);
            }
        }
    }

    console.log(`corpus: ${corpus.length} PRs / ${changedFiles.length} files`);
    console.log(`        ${withContent} with content fetched, ${overBudget} over the ${fmt(FILE_CONTENT_BUDGET_CHARS)}-char budget (omitted, never truncated)\n`);

    const before = await weigh(changedFiles, undefined);
    const after = await weigh(changedFiles, contents);

    console.log('── shard prompt weight (INPUT tokens) ────────────────────');
    console.log(`shards             ${fmt(before.shards)}  ->  ${fmt(after.shards)}   (unchanged by design)`);
    console.log(`input tokens       ${fmt(before.tokens)}  ->  ${fmt(after.tokens)}   (+${pct(after.tokens, before.tokens)}%)`);
    console.log(`prompt chars       ${fmt(before.chars)}  ->  ${fmt(after.chars)}   (+${pct(after.chars, before.chars)}%)`);
    console.log(`per shard, avg     ${fmt(Math.round(before.tokens / before.shards))}  ->  ${fmt(Math.round(after.tokens / after.shards))} tokens`);
    console.log(`per PR, avg        ${fmt(Math.round(before.tokens / corpus.length))}  ->  ${fmt(Math.round(after.tokens / corpus.length))} tokens`);
    console.log(`\nNote: shard COUNT is unchanged — step 1 makes each call heavier, it does`);
    console.log(`not make more calls. Output tokens are unaffected.`);
})().catch((e) => { console.error('FAILED:', e); process.exit(2); });
