#!/usr/bin/env node
/**
 * lint-oracle — Tier 0 deterministic ceiling for "source-only linters in the
 * sandbox". For each benchmark PR it fetches the changed files at the PR head,
 * runs the language's source-only linter (bug-focused rules, NOT style),
 * restricts diagnostics to the changed lines, and emits them in the same
 * candidate shape the judge consumes. Then run judge-sonnet.js against the
 * goldens to get "what recall would linters alone deliver".
 *
 * No engine, no sandbox rebuild, no LLM in the finding step — linters are
 * deterministic, so this is the exact ceiling, free of the benchmark's noise.
 *
 * Usage: node lint-oracle.js <run-name> [lang]
 *   lang: py | ts | go | rb | java | all   (default: all installed)
 * Output: results/<run>-lint/candidates-all.json  (aligned with golden-funnel.json)
 *         then run the judge on it.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUN = process.argv[2];
const LANG = process.argv[3] || 'all';
if (!RUN) {
    console.error('uso: node lint-oracle.js <run-name> [py|ts|go|rb|java|all]');
    process.exit(1);
}
const HERE = __dirname;
const RESULTS = path.join(HERE, 'results', RUN);
const goldenFunnel = JSON.parse(
    fs.readFileSync(path.join(RESULTS, 'golden-funnel.json'), 'utf8'),
);

const sh = (cmd) => {
    try {
        return execSync(cmd, {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (e) {
        return e.stdout || '';
    }
};

// Map golden-funnel repo ("ai-code-review-benchmark/sentry") straight to gh.
const ownerRepo = (repo) =>
    repo.includes('/') ? repo : `ai-code-review-benchmark/${repo}`;

// Parse a unified diff into { file -> Set(changedLineNumbers in new file) }.
function changedLines(diffText) {
    const byFile = {};
    let cur = null;
    let newLine = 0;
    for (const line of diffText.split('\n')) {
        const mFile = line.match(/^\+\+\+ b\/(.+)$/);
        if (mFile) {
            cur = mFile[1];
            byFile[cur] = byFile[cur] || new Set();
            continue;
        }
        const mHunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (mHunk) {
            newLine = parseInt(mHunk[1], 10);
            continue;
        }
        if (cur == null) continue;
        if (line.startsWith('+') && !line.startsWith('+++')) {
            byFile[cur].add(newLine);
            newLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            // deletion: does not advance new-file line counter
        } else {
            newLine++;
        }
    }
    return byFile;
}

const LANG_EXT = {
    py: ['.py'],
    ts: ['.ts', '.tsx', '.js', '.jsx'],
    go: ['.go'],
    rb: ['.rb', '.erb'],
    java: ['.java'],
};

function langOf(file) {
    const ext = path.extname(file);
    for (const [lang, exts] of Object.entries(LANG_EXT)) {
        if (exts.includes(ext)) return lang;
    }
    return null;
}

// Run the language linter on a temp dir of changed files; return [{file,line,rule,msg}].
function runLinter(lang, tmpDir, files) {
    const diags = [];
    // Linters report absolute paths; on macOS /tmp resolves to /private/tmp,
    // so strip via both the literal and the realpath'd tmpDir.
    let realTmp = tmpDir;
    try {
        realTmp = fs.realpathSync(tmpDir);
    } catch {}
    const rel = (fn) => {
        for (const p of [realTmp, tmpDir]) {
            if (fn.startsWith(p + '/')) return fn.slice(p.length + 1);
        }
        return fn.replace(/^\.\//, '');
    };
    if (lang === 'py') {
        // bug-focused: pyflakes(F), bugbear(B), pylint-errors/warns(PLE/PLW),
        // bandit-security(S), async, RUF, flake8-simplify/pie. NO style.
        const out = sh(
            `cd ${tmpDir} && ruff check --select F,B,PLE,PLW,S,ASYNC,RUF,SIM,PIE,A,BLE,RET,TRY,FURB --no-cache --output-format=json . 2>/dev/null`,
        );
        try {
            for (const d of JSON.parse(out || '[]')) {
                diags.push({
                    file: rel(d.filename),
                    line: d.location?.row || 0,
                    rule: d.code,
                    msg: d.message,
                });
            }
        } catch {}
    } else if (lang === 'ts') {
        // eslint via npx with a bug-focused inline config (no style rules).
        for (const f of files) {
            const out = sh(
                `cd ${tmpDir} && npx --yes eslint@8 --no-eslintrc --parser-options=ecmaVersion:2022,sourceType:module --rule '{"no-unreachable":"error","no-unused-vars":"warn","no-undef":"error","no-dupe-keys":"error","no-constant-condition":"error","no-self-compare":"error","no-fallthrough":"error","require-atomic-updates":"error"}' --format=json ${JSON.stringify(f)} 2>/dev/null`,
            );
            try {
                for (const res of JSON.parse(out || '[]')) {
                    for (const m of res.messages || []) {
                        diags.push({
                            file: f,
                            line: m.line || 0,
                            rule: m.ruleId || 'eslint',
                            msg: m.message,
                        });
                    }
                }
            } catch {}
        }
    } else if (lang === 'go') {
        // go vet / golangci-lint — needs build for type-aware checks; will be
        // partial without deps. Recorded honestly.
        const out = sh(
            `cd ${tmpDir} && golangci-lint run --no-config --disable-all -E govet,staticcheck,ineffassign,unused,errcheck --out-format=json ./... 2>/dev/null`,
        );
        try {
            const j = JSON.parse(out || '{}');
            for (const d of j.Issues || []) {
                diags.push({
                    file: rel(d.Pos?.Filename || ''),
                    line: d.Pos?.Line || 0,
                    rule: d.FromLinter,
                    msg: d.Text,
                });
            }
        } catch {}
    } else if (lang === 'rb') {
        // No rubocop gem in this env — use the built-in Ruby syntax checker.
        // .rb: `ruby -c`; .erb: compile with `erb -x` then `ruby -c`. This
        // deterministically catches syntax errors (e.g. invalid `end if`).
        for (const f of files) {
            const abs = path.join(tmpDir, f);
            const cmd = f.endsWith('.erb')
                ? `erb -x -T - ${JSON.stringify(abs)} 2>/dev/null | ruby -c 2>&1`
                : `ruby -c ${JSON.stringify(abs)} 2>&1`;
            const out = sh(cmd);
            // ruby -c prints "Syntax OK" on success, or "file:line: ... error"
            const m = out.match(/:(\d+):\s*(.*(?:error|unexpected|expecting).*)/i);
            if (m && !/Syntax OK/.test(out)) {
                diags.push({
                    file: f,
                    line: parseInt(m[1], 10),
                    rule: 'ruby-syntax',
                    msg: m[2].trim().slice(0, 160),
                    // .erb line numbers are from the COMPILED ruby, not the
                    // template — can't line-match, so attribute to the file.
                    wholeFile: f.endsWith('.erb'),
                });
            }
        }
    }
    return diags;
}

// Cross-language semgrep pass: registry rules (bug + security), source-only,
// no project deps required. Returns [{file,line,rule,msg}].
function runSemgrep(tmpDir) {
    const diags = [];
    let realTmp = tmpDir;
    try {
        realTmp = fs.realpathSync(tmpDir);
    } catch {}
    const rel = (fn) => {
        for (const p of [realTmp, tmpDir]) {
            if (fn.startsWith(p + '/')) return fn.slice(p.length + 1);
        }
        return fn.replace(/^\.\//, '');
    };
    const out = sh(
        `cd ${tmpDir} && semgrep --config=p/default --config=p/security-audit --json --metrics=off --quiet --timeout=60 . 2>/dev/null`,
    );
    try {
        const j = JSON.parse(out || '{}');
        for (const r of j.results || []) {
            diags.push({
                file: rel(r.path),
                line: r.start?.line || 0,
                rule: (r.check_id || 'semgrep').split('.').pop(),
                msg: r.extra?.message || '',
            });
        }
    } catch {}
    return diags;
}

const SEV_BY_RULE = (rule) => 'medium';

const candidates = [];
let totalDiags = 0;
const perPr = [];

for (const pr of goldenFunnel) {
    const repo = ownerRepo(pr.repo);
    const head = pr.head;
    const issues = [];
    // changed files + line ranges
    const diff = sh(`gh pr diff --repo ${repo} ${head} 2>/dev/null`);
    let diffText = diff;
    if (!diffText.trim()) {
        // fall back: resolve PR number by head
        const num = sh(
            `gh pr list --repo ${repo} --head ${head} --state all --json number --jq '.[0].number' 2>/dev/null`,
        ).trim();
        if (num)
            diffText = sh(`gh pr diff --repo ${repo} ${num} 2>/dev/null`);
    }
    const chg = changedLines(diffText);
    const files = Object.keys(chg);

    // group changed files by language (for the per-language linters)
    const byLang = {};
    for (const f of files) {
        const lang = langOf(f);
        if (!lang) continue;
        if (LANG !== 'all' && lang !== LANG && LANG !== 'semgrep') continue;
        (byLang[lang] = byLang[lang] || []).push(f);
    }

    // Fetch ALL changed source files at head into ONE temp dir per PR, so the
    // per-language linters AND the cross-language semgrep pass share them.
    const tmpDir = fs.mkdtempSync(`/tmp/lint-oracle-`);
    const fetchedByLang = {};
    const allFetched = [];
    for (const [lang, langFiles] of Object.entries(byLang)) {
        for (const f of langFiles) {
            const content = sh(
                `gh api "repos/${repo}/contents/${f}?ref=${head}" --jq '.content' 2>/dev/null`,
            );
            if (!content.trim()) continue;
            const abs = path.join(tmpDir, f);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            try {
                fs.writeFileSync(abs, Buffer.from(content, 'base64'));
                (fetchedByLang[lang] = fetchedByLang[lang] || []).push(f);
                allFetched.push(f);
            } catch {}
        }
    }

    const addDiag = (d, source) => {
        const changed = chg[d.file];
        if (d.wholeFile) {
            // line attribution unreliable (e.g. compiled ERB) — accept if the
            // file was modified by this PR at all.
            if (!changed || !changed.size) return;
        } else if (!changed || !changed.has(d.line)) {
            return; // only changed lines
        }
        issues.push({
            comment: `[${d.rule}] ${d.msg}`,
            severity: SEV_BY_RULE(d.rule),
            location: `${d.file}:${d.line}`,
            stage: 'sent',
            source,
        });
        totalDiags++;
    };

    if (allFetched.length) {
        // per-language linters
        if (LANG !== 'semgrep') {
            for (const [lang, fetched] of Object.entries(fetchedByLang)) {
                for (const d of runLinter(lang, tmpDir, fetched))
                    addDiag(d, 'linter:' + lang);
            }
        }
        // cross-language semgrep pass (registry rules, source-only, no deps)
        if (LANG === 'all' || LANG === 'semgrep') {
            for (const d of runSemgrep(tmpDir)) addDiag(d, 'semgrep');
        }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    candidates.push({
        repo: pr.repo,
        head,
        prNumber: pr.prNumber || 0,
        issues,
    });
    perPr.push(`${pr.repo}/${head}: ${issues.length} linter diag (on changed lines)`);
}

const outDir = path.join(HERE, 'results', `${RUN}-lint`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(outDir, 'candidates-all.json'),
    JSON.stringify(candidates, null, 2),
);
// copy golden alongside for the judge
fs.copyFileSync(
    path.join(RESULTS, 'golden-funnel.json'),
    path.join(outDir, 'golden-funnel.json'),
);

console.log(perPr.join('\n'));
console.log(
    `\nPRs=${candidates.length}  goldens=${goldenFunnel.reduce((a, p) => a + p.golden_comments.length, 0)}  linter-diags(changed lines)=${totalDiags}`,
);
console.log(`\nescrito: ${outDir}/candidates-all.json + golden-funnel.json`);
console.log(`\nagora rode o juiz:`);
console.log(
    `  ANTHROPIC_API_KEY=$KEY node judge-sonnet.js ${outDir}/golden-funnel.json ${outDir}/candidates-all.json ${outDir}`,
);
