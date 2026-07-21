// Multi-rule, full-PR runner for the convention-rule analog cases (Physitrack
// reproduction). Unlike behavioral-shipped.js (one rule/case, file-scope only),
// this feeds the WHOLE rule set per PR and scores each rule against its own
// groundTruthAll — so it exercises the real production regime: every applicable
// rule in the fan-out, plus the PR-scope shard. It reuses the SAME shipped
// judgeKodyRulesSharded + runJudge closure, so a number here is what ships.
//
//   node evals/kody-rules/run-convention-cases.js --model=kimi-k2.7-code --temp=none
//   node evals/kody-rules/run-convention-cases.js --model=gpt-5.4-mini --temp=0
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

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
}));
const MODELKEY = args.model || 'kimi-k2.7-code';
const CONC = Number(args.conc || 4);
const TEMP = args.temp === 'none' ? undefined : Number(args.temp ?? 0);
const LINE_TOL = 2;
const DATASET = String(args.dataset || 'rails-convention-cases').replace(/\.json$/, '');

const cases = require(`./${DATASET}.json`);
const { judgeKodyRulesSharded } = require('../../libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge.ts');
const { parseViolations, normalizePath } = require('./behavioral-scoring.ts');

const near = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= LINE_TOL;

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    // --base-url overrides the tier0 spec's baseURL AFTER applyModelEnv (which
    // resets it), so a model like glm-5.2 can be pointed at a customer's own
    // openai-compatible router (e.g. verboo) instead of the default provider.
    if (args['base-url']) process.env.API_OPENAI_FORCE_BASE_URL = args['base-url'];
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let calls = 0, errored = 0, inTok = 0, outTok = 0;
    const runJudge = async ({ system, user }) => {
        calls++;
        try {
            const res = await generateText({ model, system, prompt: user, ...(TEMP === undefined ? {} : { temperature: TEMP }) });
            const u = res.usage || {};
            inTok += u.promptTokens ?? u.inputTokens ?? 0;
            outTok += u.completionTokens ?? u.outputTokens ?? 0;
            return parseViolations(res.text);
        } catch (e) { errored++; console.error(`  shard error: ${String(e.message).slice(0, 140)}`); return []; }
    };
    // Capture the judge's own warnings — the PR-scope/file shard "degrading to
    // zero findings" line is exactly how we tell "shard failed" from "shard ran,
    // model found nothing".
    const shardWarnings = [];
    const logger = { warn: (o) => shardWarnings.push(o?.message || String(o)), error: () => {}, log: () => {}, info: () => {}, debug: () => {} };

    for (const c of cases) {
        console.log(`\n╔═ ${c.caseId} — ${MODELKEY} ═╗  files=${c.realChangedFiles.length} rules=${c.rules.length}`);
        const { violations } = await judgeKodyRulesSharded({
            changedFiles: c.realChangedFiles,
            rules: c.rules,
            runJudge,
            concurrency: CONC,
            prTitle: c.title,
            prBody: c.body,
            logger,
        });

        // targets: one per violated rule, from groundTruthAll
        const changed = c.realChangedFiles.map((f) => normalizePath(f.filename));
        const targets = Object.entries(c.groundTruthAll).map(([uuid, files]) => {
            const violFiles = Object.keys(files).map(normalizePath);
            const sites = Object.entries(files).flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
            return { uuid, sites, violFiles, okFiles: changed.filter((f) => !violFiles.includes(f)) };
        });
        const prScopeUuids = new Set(c.rules.filter((r) => r.scope === 'pull-request').map((r) => r.uuid));

        let occTotal = 0, occCaught = 0, fileTotal = 0, fileCaught = 0, flagsTotal = 0, onTarget = 0, falseClean = 0;
        const rows = [];
        for (const t of targets) {
            const tSugg = violations.filter((v) => (v.brokenKodyRulesIds || []).includes(t.uuid) || v.ruleUuid === t.uuid);
            const flags = tSugg.map((v) => ({ file: normalizePath(v.relevantFile), line: v.relevantLinesStart })).filter((x) => x.file && Number.isFinite(x.line));
            const flaggedFiles = new Set(flags.map((x) => x.file));
            const covered = t.sites.filter((g) => flags.some((x) => near(x, g))).length;
            const fileHits = t.violFiles.filter((f) => flaggedFiles.has(f)).length;
            const ot = flags.filter((x) => t.sites.some((g) => near(x, g))).length;
            occTotal += t.sites.length; occCaught += covered;
            fileTotal += t.violFiles.length; fileCaught += fileHits;
            flagsTotal += flags.length; onTarget += ot;
            falseClean += t.okFiles.filter((f) => flaggedFiles.has(f)).length;
            rows.push({ uuid: t.uuid, sites: t.sites.length, covered, vf: t.violFiles.length, fileHits, pr: prScopeUuids.has(t.uuid) });
        }

        const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '—');
        rows.sort((a, b) => (a.covered / a.sites) - (b.covered / b.sites));
        console.log('  rule                                    sites caught  files fileHits');
        for (const r of rows) {
            const flag = r.pr ? ' [PR-scope]' : '';
            const mark = r.covered === 0 ? '  ✗ MISS' : (r.covered < r.sites ? '  ~ partial' : '  ✓');
            console.log(`  ${r.uuid}  ${String(r.sites).padStart(4)} ${String(r.covered).padStart(5)}  ${String(r.vf).padStart(4)} ${String(r.fileHits).padStart(6)}${mark}${flag}`);
        }
        console.log(`  ── OCCURRENCE recall ${pct(occCaught, occTotal)}% (${occCaught}/${occTotal}) · FILE recall ${pct(fileCaught, fileTotal)}% (${fileCaught}/${fileTotal}) · line-precision ${pct(onTarget, flagsTotal)}% · false-on-clean ${falseClean}`);
        console.log(`  ── LLM calls ${calls} (${errored} errored) · tokens in=${inTok} out=${outTok}`);
        if (shardWarnings.length) console.log(`  ── shard warnings (${shardWarnings.length}):\n     ` + shardWarnings.slice(0, 6).join('\n     '));
        else console.log('  ── shard warnings: none (no shard degraded to zero)');
    }
}
main().catch((e) => { console.error(e); process.exit(2); });
