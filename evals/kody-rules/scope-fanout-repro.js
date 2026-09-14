// REPRO + REGRESSION harness for issue #1826 step 1b: the language scope a rule
// states in its OWN TEXT used to live inside the compiled detector, and a
// detector exists only for mechanical rules — 816 of 10.918 active rules in
// production (7,5%). Every other rule was sharded against every changed file in
// the PR no matter what language it named.
//
//   node evals/kody-rules/scope-fanout-repro.js [--rules=scope-rules] [--corpus=polyglot-cases]
//
// It drives the SHIPPED judge (`judgeKodyRulesSharded`) — not a reimplementation
// — so what it measures IS what production does. NO MODEL CALL: `runJudge` is a
// counter that returns no violations, because the two quantities that matter
// here are both structural.
//
//   FAN-OUT   how many (file x rule) shards the sweep issues. This is the cost:
//             one shard is one LLM call, so it is linear in the number the judge
//             decides to look at.
//   BLAST     of the files a rule reached, how many are of a language the rule
//             does not even name. Every one of those is a chance to publish a
//             comment the customer will thumb down — the #1831 incident measured
//             93,6% of one Ruby rule's hits landing on other languages.
//
// A model call cannot make either number better or worse; it can only decide
// what to do inside a shard that was already issued. That is why this
// measurement is exact rather than sampled, and why it costs nothing to run.
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
const RULES = args.rules || 'scope-rules';
const CORPUS = args.corpus || 'polyglot-cases';

const { judgeKodyRulesSharded } = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge');

// Extension -> language, for SCORING only: the engine never sees this map and
// enumerates no language anywhere. Same device, same reason, as the map in
// detector-fp-repro.js.
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
    '.html': 'html', '.hbs': 'html', '.xml': 'xml', '.rs': 'rust', '.c': 'c', '.h': 'c',
};
const extOf = (f) => (String(f).match(/\.[^./]+$/) || ['(none)'])[0];
const langOf = (f) => LANG_BY_EXT[extOf(f)] || null;
// A Ruby rule DOES apply to .erb — the template really does contain Ruby.
// An UNKNOWN extension is never counted as wrong: we cannot tell, and guessing
// would manufacture the very over-narrowing this change is careful to avoid.
const wrongLanguage = (filename, ruleLang) => {
    if (!ruleLang) return false;
    const l = langOf(filename);
    if (!l) return false;
    return !(l === ruleLang || (ruleLang === 'ruby' && l === 'ruby-template'));
};

const seed = require('./' + RULES + '.json');
const ruleDefs = Array.isArray(seed) ? seed : seed.rules;
const corpus = require('./' + CORPUS + '.json');
const changedFiles = [];
for (const c of corpus) for (const f of (c.realChangedFiles || c.changedFiles || [])) changedFiles.push(f);

// Count the shards and record which files each rule actually reached.
async function sweep(rules) {
    const reached = new Map(); // ruleUuid -> Set(filename)
    const res = await judgeKodyRulesSharded({
        changedFiles,
        rules,
        runJudge: async ({ filename, ruleUuids }) => {
            for (const u of ruleUuids) {
                if (!u) continue;
                if (!reached.has(u)) reached.set(u, new Set());
                reached.get(u).add(filename);
            }
            return [];
        },
    });
    return { shardsRun: res.shardsRun, reached };
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '0.0');
const byExt = (files) => {
    const m = {};
    for (const f of files) { const e = extOf(f); m[e] = (m[e] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)';
};

(async () => {
    const exts = {};
    for (const f of changedFiles) { const e = extOf(f.filename); exts[e] = (exts[e] || 0) + 1; }
    console.log(`corpus: ${corpus.length} PRs / ${changedFiles.length} files`);
    console.log(`        ${Object.entries(exts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}\n`);

    // BEFORE: the scope exists in the rule's text but has nowhere to live, so
    // every rule is offered every file. This is production today for the 92,5%.
    const before = await sweep(ruleDefs.map((r) => ({ uuid: r.uuid, title: r.title, rule: r.rule })));
    // AFTER: the same rules carrying the scope the compiler infers at save time.
    const after = await sweep(ruleDefs.map((r) => ({
        uuid: r.uuid, title: r.title, rule: r.rule,
        ...(r.extensions ? { fileScope: { extensions: r.extensions, sourceHash: 'x', source: 'compiler', inferredAt: new Date() } } : {}),
    })));

    let totB = 0, totA = 0, wrongB = 0, wrongA = 0;
    for (const r of ruleDefs) {
        const b = [...(before.reached.get(r.uuid) || [])];
        const a = [...(after.reached.get(r.uuid) || [])];
        const wb = b.filter((f) => wrongLanguage(f, r.language)).length;
        const wa = a.filter((f) => wrongLanguage(f, r.language)).length;
        totB += b.length; totA += a.length; wrongB += wb; wrongA += wa;
        console.log(`== ${r.title}`);
        console.log(`   scope: ${r.extensions ? JSON.stringify(r.extensions) : '(agnostic — control, must not narrow)'}`);
        console.log(`   files reached  before ${b.length}  ->  after ${a.length}   (${pct(b.length - a.length, b.length)}% fewer)`);
        console.log(`   wrong-language before ${wb} (${pct(wb, b.length)}%)  ->  after ${wa} (${pct(wa, a.length)}%)`);
        console.log(`   after: ${byExt(a)}\n`);
    }

    console.log('── totals ────────────────────────────────────────────────');
    console.log(`shards issued (= LLM calls): ${before.shardsRun}  ->  ${after.shardsRun}`);
    console.log(`rule x file pairs judged:    ${totB}  ->  ${totA}   (${pct(totB - totA, totB)}% fewer)`);
    console.log(`of those, wrong language:    ${wrongB} (${pct(wrongB, totB)}%)  ->  ${wrongA} (${pct(wrongA, totA)}%)`);

    // The control must be untouched: narrowing a language-agnostic rule would
    // be a silent enforcement loss, which is worse than the cost it saves.
    const ctrl = ruleDefs.find((r) => !r.extensions);
    if (ctrl) {
        const b = (before.reached.get(ctrl.uuid) || new Set()).size;
        const a = (after.reached.get(ctrl.uuid) || new Set()).size;
        console.log(`\ncontrol "${ctrl.title}": ${b} -> ${a} files  ${b === a ? 'OK (unchanged)' : 'REGRESSION — an agnostic rule was narrowed'}`);
        if (b !== a) process.exitCode = 1;
    }
})().catch((e) => { console.error('FAILED:', e); process.exit(2); });
