// REPRO + REGRESSION harness for issue #1831: T0 kody-rule detectors published
// a PR comment for every regex hit, with no LLM confirmation and no language
// scope — so a Ruby-only rule commented on .js/.scss/.tsx/.yml.
//
//   node evals/kody-rules/detector-fp-repro.js [--rules=detectors-1831] [--corpus=polyglot-cases]
//   node evals/kody-rules/detector-fp-repro.js --judge [--model=kimi-k2.7-code] [--conc=4]
//
// It drives the SHIPPED engine code — not a reimplementation — so what it
// measures IS what production does, and the same command run before and after
// a change measures the change rather than a model of it.
//
// The fix is three independent layers, and this reports each one separately,
// because each one alone would have prevented the incident:
//
//   L1 compile gate   — a linter-owned cosmetic rule never gets a detector.
//   L2 language scope — a detector only runs on the extensions its rule names.
//   L3 judge          — surviving hits are candidates an LLM confirms or drops.
//
// L1/L2 are free and deterministic. L3 costs a model call and needs --judge.
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

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const RULES = args.rules || 'detectors-1831';
const CORPUS = args.corpus || 'polyglot-cases';
const SAMPLES = +(args.samples || 3);
const JUDGE = !!args.judge;
const MODELKEY = args.model || 'kimi-k2.7-code';
const CONC = +(args.conc || 4);

const {
    buildDetectorCandidates,
    isCosmeticRule,
} = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler');
const { judgeKodyRulesSharded } = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge');

// Extension → language, for SCORING only: the engine never sees this map. A
// published finding on a file whose language is not the rule's own language is
// a certain false positive — no judgment call, the rule does not apply there.
const LANG_BY_EXT = {
    '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby', '.ru': 'ruby',
    '.erb': 'ruby-template', '.haml': 'ruby-template', '.slim': 'ruby-template',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.gjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.vue': 'vue', '.svelte': 'svelte',
    '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
    '.yml': 'yaml', '.yaml': 'yaml', '.json': 'json', '.toml': 'toml',
    '.md': 'markdown', '.mdx': 'markdown', '.txt': 'text',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.sql': 'sql', '.py': 'python', '.go': 'go', '.java': 'java', '.php': 'php',
    '.html': 'html', '.hbs': 'html', '.xml': 'xml',
};
const extOf = (f) => (String(f).match(/\.[^./]+$/) || ['(none)'])[0];
const langOf = (f) => LANG_BY_EXT[extOf(f)] || null;
const inLanguage = (filename, ruleLang) => {
    if (!ruleLang) return true;
    const l = langOf(filename);
    // A Ruby rule DOES apply to .erb — the template really does contain Ruby.
    // That is exactly why those hits need judgment and not an extension check:
    // the incident's .erb hits were all JavaScript embedded in the template.
    return l === ruleLang || (ruleLang === 'ruby' && l === 'ruby-template');
};

const seed = require('./' + RULES + '.json');
const rules = Array.isArray(seed) ? seed.filter((r) => r?.detector) : seed.detectors;
const corpus = require('./' + CORPUS + '.json');
const changedFiles = [];
for (const c of corpus) for (const f of (c.realChangedFiles || c.changedFiles || [])) changedFiles.push(f);
const addedLines = changedFiles.reduce((n, f) => n + String(f.patchWithLinesStr || '').split('\n').filter((l) => /^\s*\d+\s*\+/.test(l)).length, 0);

// Flatten a DetectorHitIndex into {ruleUuid, filename, line} triples.
function flatten(index) {
    const out = [];
    for (const [ruleUuid, perFile] of index) for (const [filename, lines] of perFile) for (const line of lines) out.push({ ruleUuid, filename, line });
    return out;
}
function byExt(items) {
    const m = {};
    for (const it of items) { const e = extOf(it.filename); m[e] = (m[e] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)';
}
function score(items, ruleLang) {
    const wrong = items.filter((it) => !inLanguage(it.filename, ruleLang)).length;
    return { total: items.length, wrong, pct: items.length ? ((wrong / items.length) * 100).toFixed(1) : '0.0' };
}

(async () => {
    console.log(`corpus: ${corpus.length} PRs / ${changedFiles.length} files / ${addedLines} added lines`);
    console.log(`rules:  ${rules.length} with a compiled detector\n`);

    for (const rule of rules) {
        const ruleLang = rule.language || null;
        console.log(`══ ${rule.title}`);
        console.log(`   pattern=${rule.detector.pattern}  path=${JSON.stringify(rule.path || '')}  language=${ruleLang || '(none declared)'}\n`);

        // L1 — would this rule get a detector at all today?
        const cosmetic = isCosmeticRule(rule);
        console.log(`   L1 compile gate: ${cosmetic ? 'DECLINED as cosmetic — no detector is compiled, so nothing downstream can fire' : 'compiles (not cosmetic)'}`);

        // L2a — the detector exactly as production stored it: no extensions.
        // This is the pre-fix blast radius, and also what the 424 already-shipped
        // unscoped detectors still look like until they are recompiled.
        const legacy = flatten(buildDetectorCandidates([rule], changedFiles));
        const sLegacy = score(legacy, ruleLang);
        console.log(`   L2 unscoped detector (as shipped today): ${sLegacy.total} candidates — ${sLegacy.wrong} (${sLegacy.pct}%) on the wrong language`);
        console.log(`      ${byExt(legacy)}`);

        // L2b — the same detector recompiled with the language scope the new
        // compiler prompt asks for.
        const scoped = rule.expectedExtensions
            ? flatten(buildDetectorCandidates([{ ...rule, detector: { ...rule.detector, extensions: rule.expectedExtensions } }], changedFiles))
            : null;
        if (scoped) {
            const sScoped = score(scoped, ruleLang);
            console.log(`   L2 recompiled with extensions ${JSON.stringify(rule.expectedExtensions)}: ${sScoped.total} candidates — ${sScoped.wrong} (${sScoped.pct}%) on the wrong language`);
            console.log(`      ${byExt(scoped)}`);
        }

        // L3 — the surviving candidates go to the judge, which sees the whole
        // file diff and can tell Ruby from embedded JavaScript from a heredoc.
        const forJudge = scoped ?? legacy;
        if (!JUDGE) {
            console.log(`\n   L3 judge: not run (pass --judge). ${forJudge.length} candidate(s) would be offered to it.`);
            const files = new Set(forJudge.map((c) => c.filename));
            console.log(`      cost: ${files.size} of ${changedFiles.length} files reach a model (${((files.size / changedFiles.length) * 100).toFixed(1)}%).`);
            for (const c of forJudge.slice(0, SAMPLES * 2)) {
                const line = String(changedFiles.find((f) => f.filename === c.filename)?.patchWithLinesStr || '').split('\n').find((l) => new RegExp(`^\\s*${c.line}\\s*\\+`).test(l)) || '';
                console.log(`      ${c.filename}:${c.line}  ${line.replace(/^\s*\d+\s*\+/, '').trim().slice(0, 96)}`);
            }
            console.log('');
            continue;
        }

        const { applyModelEnv } = require('../shared/tier0-models');
        const { buildEvalModel } = require('../shared/build-model');
        applyModelEnv(MODELKEY);
        const model = buildEvalModel({});
        const { generateText } = require('ai');

        // Rebuild the hit index the judge consumes (scoped when we have a scope).
        const index = buildDetectorCandidates(
            [scoped ? { ...rule, detector: { ...rule.detector, extensions: rule.expectedExtensions } } : rule],
            changedFiles,
        );
        const touched = new Set(forJudge.map((c) => c.filename));
        const filesForJudge = changedFiles.filter((f) => touched.has(f.filename));

        const runJudge = async ({ system, user }) => {
            const res = await generateText({ model, system, prompt: user });
            const txt = String(res.text || '');
            const m = txt.match(/\{[\s\S]*\}/);
            if (!m) return [];
            try { return JSON.parse(m[0]).violations ?? []; } catch { return []; }
        };

        console.log(`\n   L3 judge (${MODELKEY}): ${filesForJudge.length} file shard(s)…`);
        const result = await judgeKodyRulesSharded({
            changedFiles: filesForJudge,
            rules: [rule],
            runJudge,
            concurrency: CONC,
            detectorHits: index,
            logger: { warn: (e) => console.warn('      warn:', e.message) },
        });
        const published = result.violations.map((v) => ({ filename: v.relevantFile, line: v.relevantLinesStart, summary: v.oneSentenceSummary }));
        const sPub = score(published, ruleLang);
        console.log(`   L3 published after confirmation: ${sPub.total} (was ${sLegacy.total} before the fix) — ${sPub.wrong} on the wrong language`);
        console.log(`      shards run ${result.shardsRun}, errored ${result.shardsErrored}`);
        if (published.length) {
            console.log(`      ${byExt(published)}`);
            for (const p of published.slice(0, SAMPLES * 3)) console.log(`      ${p.filename}:${p.line}  ${String(p.summary || '').slice(0, 90)}`);
        }
        console.log('');
    }
})();
