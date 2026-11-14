#!/usr/bin/env node
// security-scan on RealVuln (v1.0.0, see realvuln/LICENSE, https://huggingface.co/datasets/Kolega-Dev/RealVuln):
// 26 Python repositories at a pinned commit, 676 labelled vulnerabilities and
// 120 false-positive traps. Production's scan runs on each repository
// (scan-repo.js, the same call as run.js) and is scored with RealVuln's own
// rule, so the numbers sit in the paper's table (arXiv 2604.13764, Table 4)
// next to Semgrep, Snyk, SonarQube and the agentic LLMs.
//
//   node evals/security-scan/realvuln.js [--model=<tier-0 id>] [--repos=<id,...>|dev]
//     [--budget=<usd per repository>] [--concurrency=N] [--output=<result.json>]
//   node evals/security-scan/realvuln.js --rescore=<result.json>
//
// The rule (paper §3.3, scorer/matcher.py): a finding matches a ground-truth
// entry of its repository when the file is the same after normalization, its
// CWE is in the entry's acceptable_cwes, and its line is within ±10 of the
// entry's range. Real vulnerabilities are preferred over traps, and each entry
// is consumed once, in the scanner's order. TP = a real entry matched; FP = a
// trap matched or nothing matched; FN = a real entry never matched. Counts are
// pooled over every repository ("strict micro"): a repository the scan could
// not run on contributes its vulnerabilities as misses.
const fs = require('fs');
const path = require('path');

const { countTokens, tokensUsed, registerTs } = require('../shared/eval-kit');
const { orgRouteOrExit } = require('../shared/model-route');

registerTs();
countTokens();

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const BUDGET_USD = Number(args.budget || 3);
const CONCURRENCY = Math.max(1, Number(args.concurrency || 4));
const LINE_TOLERANCE = 10;
const OUT = args.output || path.join(__dirname, '..', 'results', `security-scan-realvuln-${MODEL.replace(/[^\w.-]/g, '_')}.json`);

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const DATA = path.join(__dirname, 'realvuln');
const readJsonl = (f) =>
    fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const REPOS = readJsonl('repos.jsonl');
const GROUND_TRUTH = readJsonl('findings.jsonl');

// Published in the paper (Table 4), strict micro over the 26 repositories.
const PUBLISHED = [
    ['Kolega.Dev v0.0.1', 0.388, 0.809, 73.0],
    ['Claude Sonnet 4.6 (agentic)', 0.785, 0.498, 51.7],
    ['Gemini 3.1 Pro (agentic)', 0.774, 0.491, 51.0],
    ['Claude Opus 4.6 (agentic)', 0.79, 0.456, 47.7],
    ['Kimi K2.5 (agentic)', 0.683, 0.45, 46.6],
    ['GLM-5 (agentic)', 0.753, 0.439, 45.8],
    ['MiniMax M2.7 (agentic)', 0.707, 0.371, 39.0],
    ['Qwen 3.5 397B (agentic)', 0.618, 0.366, 38.1],
    ['Claude Haiku 4.5 (agentic)', 0.748, 0.352, 37.2],
    ['Grok 4.20 reasoning (agentic)', 0.927, 0.263, 28.4],
    ['Grok 3 (agentic)', 0.837, 0.197, 21.3],
    ['Semgrep', 0.205, 0.175, 17.7],
    ['Snyk', 0.282, 0.167, 17.4],
    ['SeqLab taskflow agent v1', 0.605, 0.077, 8.4],
    ['SonarQube', 0.611, 0.065, 7.1],
];

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');

/** RealVuln's matcher over one repository's findings, in the scan's order. */
function scoreRepository(repoId, findings) {
    const entries = GROUND_TRUTH.filter((g) => g.repo_id === repoId);
    const consumed = new Set();
    const scored = findings.map((f) => {
        const candidates = entries
            .filter(
                (g) =>
                    !consumed.has(g.finding_id) &&
                    norm(g.file) === norm(f.file) &&
                    f.cwe &&
                    (g.acceptable_cwes ?? []).includes(f.cwe) &&
                    (f.line == null ||
                        g.start_line == null ||
                        (f.line >= g.start_line - LINE_TOLERANCE &&
                            f.line <= (g.end_line ?? g.start_line) + LINE_TOLERANCE)),
            )
            .sort((a, b) => Number(b.is_vulnerable) - Number(a.is_vulnerable));
        const hit = candidates[0];
        if (hit) consumed.add(hit.finding_id);
        return { ...f, match: hit ? hit.finding_id : null, outcome: hit?.is_vulnerable ? 'tp' : 'fp', trap: !!hit && !hit.is_vulnerable };
    });
    const real = entries.filter((g) => g.is_vulnerable);
    const traps = entries.filter((g) => !g.is_vulnerable);
    return {
        findings: scored,
        tp: scored.filter((f) => f.outcome === 'tp').length,
        fp: scored.filter((f) => f.outcome === 'fp').length,
        fn: real.filter((g) => !consumed.has(g.finding_id)).length,
        tn: traps.filter((g) => !consumed.has(g.finding_id)).length,
        real: real.length,
        missed: real.filter((g) => !consumed.has(g.finding_id)).map((g) => ({ id: g.finding_id, class: g.vulnerability_class, file: g.file, line: g.start_line })),
    };
}

function metrics({ tp, fp, fn }) {
    const p = tp + fp ? tp / (tp + fp) : 0;
    const r = tp + fn ? tp / (tp + fn) : 0;
    const f = (beta) => (p + r ? ((1 + beta * beta) * p * r) / (beta * beta * p + r) : 0);
    return { precision: p, recall: r, f1: 100 * f(1), f2: 100 * f(2), f3: 100 * f(3) };
}

function report(repos, tokens) {
    const pooled = repos.reduce(
        (a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn, tn: a.tn + r.tn }),
        { tp: 0, fp: 0, fn: 0, tn: 0 },
    );
    const m = metrics(pooled);
    const usd = repos.reduce((s, r) => s + (r.spend?.usd ?? 0), 0);
    const result = {
        eval: 'security-scan-realvuln',
        dataset: 'RealVuln v1.0.0 (26 Python repositories, 676 vulnerabilities, 120 traps)',
        model: MODEL,
        budgetUsdPerRepository: BUDGET_USD,
        ...pooled,
        ...m,
        usd,
        repos,
        tokens,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

    const ours = [`Kodus deep scan (${MODEL}, $${BUDGET_USD}/repo)`, m.precision, m.recall, m.f3];
    const table = [...PUBLISHED, ours].sort((a, b) => b[3] - a[3]);
    console.log(`\nRealVuln strict micro: TP ${pooled.tp} · FP ${pooled.fp} · FN ${pooled.fn} · traps hit ${repos.reduce((s, r) => s + r.findings.filter((f) => f.trap).length, 0)} · $${usd.toFixed(2)} → ${OUT}`);
    for (const [name, p, r, f3] of table) {
        const mark = name === ours[0] ? '→' : ' ';
        console.log(`${mark} F3 ${f3.toFixed(1).padStart(5)}  P ${p.toFixed(3)}  R ${r.toFixed(3)}  ${name}`);
    }
    return result;
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i]);
            }
        }),
    );
    return out;
}

async function main() {
    if (args.rescore) {
        const saved = JSON.parse(fs.readFileSync(args.rescore, 'utf8'));
        const repos = saved.repos.map((r) => ({ ...r, ...scoreRepository(r.id, r.findings.map(({ file, cwe, line, endLine, title, vulnerabilityClass }) => ({ file, cwe, line, endLine, title, vulnerabilityClass }))) }));
        return report(repos, saved.tokens);
    }

    const { pricingResolver, scanRepository } = require('./scan-repo');
    const route = orgRouteOrExit(MODEL);
    const pricing = pricingResolver();
    // A fixed slice to iterate on; the whole set confirms a winner.
    const DEV_SLICE = ['dsvw', 'damn-vulnerable-flask-app', 'dsvpwa', 'vampi', 'flask-xss', 'vulnerable-flask-app', 'threatbyte', 'extremely-vulnerable-flask-app'];
    const wanted = args.repos === 'dev' ? DEV_SLICE : args.repos ? String(args.repos).split(',') : null;
    const picked = wanted ? REPOS.filter((r) => wanted.includes(r.repo_id)) : REPOS;

    const repos = await pool(picked, CONCURRENCY, async (r) => {
        const repo = r.repo_url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
        const started = Date.now();
        try {
            const { result, shipped, spend } = await scanRepository({
                c: { id: r.repo_id, repo, commit: r.commit_sha },
                route,
                pricing,
                budgetUsd: BUDGET_USD,
            });
            const findings = shipped.map((f) => ({
                file: f.filePath,
                cwe: f.cwe,
                line: f.startLine,
                endLine: f.endLine,
                vulnerabilityClass: f.vulnerabilityClass,
                title: f.title,
            }));
            const scored = scoreRepository(r.repo_id, findings);
            // The engine's findings before one-per-identity: what the issue
            // key folds away, scored the same way (diagnostic only).
            const raw = scoreRepository(
                r.repo_id,
                result.findings.map((f) => ({ file: f.filePath, cwe: f.cwe, line: f.startLine })),
            );
            const out = {
                id: r.repo_id,
                repo,
                commit: r.commit_sha,
                ...scored,
                raw: { findings: result.findings.length, tp: raw.tp, fp: raw.fp },
                surface: { errors: result.surfaceErrors ?? [] },
                coverage: {
                    units: result.units.length,
                    done: result.progress.filter((p) => p.state === 'done').length,
                    skippedByBudget: result.progress.filter((p) => p.state === 'skipped_budget').length,
                },
                spend,
                ms: Date.now() - started,
            };
            console.log(`${r.repo_id}: TP ${out.tp}/${out.real} · FP ${out.fp} · raw ${out.raw.tp}/${out.raw.findings} · ${out.coverage.done}/${out.coverage.units} units · $${spend.usd.toFixed(2)}`);
            return out;
        } catch (error) {
            // Not run: its vulnerabilities count as misses (strict micro).
            console.error(`${r.repo_id}: not measured — ${error.message}`);
            return { id: r.repo_id, repo, commit: r.commit_sha, error: String(error.message).slice(0, 300), ...scoreRepository(r.repo_id, []) };
        }
    });

    return report(repos, tokensUsed());
}

main().catch((error) => {
    // The stack only: an error object can carry request headers.
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
});
