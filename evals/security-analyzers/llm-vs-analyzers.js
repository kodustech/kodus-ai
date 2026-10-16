// Do the deterministic analyzers find things the LLM reviewer misses?
//
// The security benchmark scores analyzers in isolation: it says the rule pack
// detects 8 of 66 published vulnerabilities with no false positives. That is
// not the question the feature has to answer. A finding the reviewer already
// makes is not new evidence, it is a duplicate — so the value of an analyzer is
// what it catches that the LLM does not.
//
// This runs the SAME security review prompt production uses over the SAME
// samples, and crosses the two.
//
//   node evals/security-analyzers/llm-vs-analyzers.js --analyzers=rp.json,bl.json
//
// Approximation, stated plainly: the production agent can investigate the
// repository with tools, and this issues one pass over the diff. The samples
// are one to eight files centred on a vulnerability, so there is little repo to
// investigate — but this is the reviewer's single-pass behaviour, not its
// ceiling.
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
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
}));
const MODEL = args.model || 'claude-sonnet-4-6';
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONCURRENCY = Number(args.concurrency || 4);

const { applyModelEnv } = require('../shared/tier0-models');
const { buildEvalModel } = require('../shared/build-model');

function infra(msg) { console.error(`\n❌ INFRA ERROR: ${msg}`); process.exit(2); }

const { buildCategoryReviewPrompt } = require(
    '../../libs/code-review/infrastructure/agents/prompts/review-prompt-blocks.ts',
);

const DATASET = args.dataset || path.join(__dirname, '../../scripts/security-benchmark/dataset.json');

/** New-side line numbers a patch adds, mirroring the pipeline's clipping. */
function addedLines(patch) {
    const out = new Set();
    let cursor = 0;
    for (const line of String(patch || '').split('\n')) {
        const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) { cursor = parseInt(h[1], 10); continue; }
        if (line.startsWith('+')) { out.add(cursor); cursor++; }
        else if (!line.startsWith('-')) cursor++;
    }
    return out;
}

function buildDiff(sample) {
    return (sample.files || [])
        .filter((f) => f.patch)
        .map((f) => `--- a/${f.path || f.filename}\n+++ b/${f.path || f.filename}\n${f.patch}`)
        .join('\n\n');
}

async function reviewOne(model, generateText, sample) {
    const diff = buildDiff(sample);
    if (!diff.trim()) return { findings: [], skipped: true };

    const res = await generateText({
        model,
        system: buildCategoryReviewPrompt('security'),
        prompt:
            'Review this pull request diff for SECURITY vulnerabilities only.\n\n' +
            'Report every vulnerability you are confident is real and introduced by the ADDED lines.\n' +
            'Respond with JSON only, no prose:\n' +
            '{"findings":[{"file":"<path exactly as in the diff>","line":<new-side line number>,' +
            '"severity":"critical|high|medium|low","title":"<short>"}]}\n' +
            'If there is nothing, respond {"findings":[]}.\n\n' +
            '```diff\n' + diff + '\n```',
        maxRetries: 2,
    });

    const text = res.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { findings: [], unparsed: true };
    try { return { findings: JSON.parse(m[0]).findings || [] }; }
    catch { return { findings: [], unparsed: true }; }
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

async function main() {
    try { applyModelEnv(MODEL); } catch (e) { infra(`model env: ${e.message}`); }

    let generateText;
    try { ({ generateText } = require('ai')); } catch (e) { infra(`ai sdk: ${e.message}`); }

    let model;
    try { model = buildEvalModel({}, MODEL); } catch (e) { infra(`build model: ${e.message}`); }

    const data = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
    const all = Array.isArray(data) ? data : Object.values(data).find(Array.isArray);
    const TRANCHE = args.tranche || 'vuln';
    const vuln = all.filter((s) => s.tranche === TRANCHE).slice(0, LIMIT);

    // Analyzer detections, per sample, from run.mjs --json output.
    const analyzerHit = new Set();
    for (const f of String(args.analyzers || '').split(',').filter(Boolean)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const rows = Array.isArray(j) ? j : Object.values(j).find(Array.isArray);
        for (const r of rows) if (r.detected) analyzerHit.add(r.id);
    }

    process.stderr.write(`reviewing ${vuln.length} samples with ${MODEL}\n`);

    const results = await pool(vuln, CONCURRENCY, async (sample, idx) => {
        let r;
        try { r = await reviewOne(model, generateText, sample); }
        catch (e) { r = { findings: [], error: String(e.message || e).slice(0, 120) }; }

        const expected = new Map(
            (sample.expected || []).map((e) => [e.path, new Set(e.lines)]),
        );
        const addedByFile = new Map(
            (sample.files || []).map((f) => [f.path || f.filename, addedLines(f.patch)]),
        );

        const onExpected = (r.findings || []).some(
            (f) => expected.get(f.file)?.has(Number(f.line)),
        );
        const inFile = (r.findings || []).some((f) => expected.has(f.file));
        const inDiff = (r.findings || []).some(
            (f) => addedByFile.get(f.file)?.has(Number(f.line)),
        );

        process.stderr.write(`${idx + 1} `);
        return {
            id: sample.id, cwe: sample.cweLabel, language: sample.language,
            llmDetected: onExpected, llmFileHit: inFile, llmInDiff: inDiff,
            llmFindings: (r.findings || []).length,
            analyzerDetected: analyzerHit.has(sample.id),
            error: r.error, unparsed: r.unparsed,
        };
    });

    const n = results.length;
    const llm = results.filter((r) => r.llmDetected).length;
    const ana = results.filter((r) => r.analyzerDetected).length;
    const both = results.filter((r) => r.llmDetected && r.analyzerDetected).length;
    const anaOnly = results.filter((r) => r.analyzerDetected && !r.llmDetected);
    const llmOnly = results.filter((r) => !r.analyzerDetected && r.llmDetected).length;
    const neither = results.filter((r) => !r.llmDetected && !r.analyzerDetected).length;
    const errs = results.filter((r) => r.error).length;
    const unp = results.filter((r) => r.unparsed).length;

    const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
    console.log(`\n\n=== LLM security review vs deterministic analyzers (${MODEL}) ===`);
    console.log(`samples: ${n}   model errors: ${errs}   unparseable replies: ${unp}\n`);
    console.log(`LLM detected            : ${llm}/${n}  (${pct(llm)})`);
    console.log(`analyzers detected      : ${ana}/${n}  (${pct(ana)})`);
    console.log(`\n  both                  : ${both}`);
    console.log(`  analyzer ONLY         : ${anaOnly.length}   <- the value case`);
    console.log(`  LLM ONLY              : ${llmOnly}`);
    console.log(`  neither               : ${neither}`);
    console.log(`\nLLM findings landing anywhere in an expected FILE: ${results.filter((r) => r.llmFileHit).length}/${n}`);
    console.log(`LLM findings landing on any ADDED line           : ${results.filter((r) => r.llmInDiff).length}/${n}`);
    console.log(`mean LLM findings per sample                     : ${(results.reduce((a, r) => a + r.llmFindings, 0) / n).toFixed(2)}`);

    if (TRANCHE === 'noise') {
        const noisy = results.filter((r) => r.llmFindings > 0);
        console.log(`\n=== noise tranche: code that only LOOKS dangerous ===`);
        console.log(`LLM stayed quiet   : ${n - noisy.length}/${n}`);
        console.log(`LLM false findings : ${results.reduce((a, r) => a + r.llmFindings, 0)} across ${noisy.length} sample(s)`);
        for (const r of noisy) console.log(`  flagged ${r.id} (${r.language}) x${r.llmFindings}`);
    }

    if (anaOnly.length) {
        console.log('\nanalyzer-only detections:');
        for (const r of anaOnly) console.log(`  ${r.id}  ${r.cwe}  (${r.language})`);
    }

    const out = args.json || path.join(__dirname, 'last-run.json');
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\nper-sample: ${out}`);
}

main().catch((e) => infra(String(e && e.stack || e)));
