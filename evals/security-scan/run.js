#!/usr/bin/env node
// security-scan: production's scan engine (libs/security-scan/application/
// security-scan-engine.ts, the same SecurityScanEngine.run the job runs) over
// real repositories at a commit with published vulnerabilities (VulnGym,
// vulngym-cases.json), on the org's model route and production's sandbox, with
// the same spend meter the job uses. It scores what the engine returns, which
// is what the job stores as Kody Issues.
//
//   node evals/security-scan/run.js [--model=<tier-0 id>] [--cases=<id,...>]
//     [--budget=<usd per case>] [--sandbox=local|e2b] [--concurrency=N]
//     [--output=<result.json>] [--gate]
//   node evals/security-scan/run.js --model=eval-fake --set=wiring   (the wiring smoke: no keys)
//   node evals/security-scan/run.js --rescore=<result.json> [--output=…] [--gate]
//     (re-reads a saved run with the current adjudications.json, no model call)
//
// A finding matches an advisory when it is in a file of the advisory's path
// (the vulnerable operation, the entry point or a step between) within
// LINE_WINDOW lines of it. Findings that match none are written out for a
// person to judge (adjudications.json); precision counts only judged findings.
//
// Exit: 0 pass, 1 below a floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');

const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { countTokens, tokensUsed, registerTs } = require('../shared/eval-kit');
const { orgRouteOrExit } = require('../shared/model-route');
const { pricingResolver, scanRepository } = require('./scan-repo');

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
const SANDBOX = args.sandbox === 'e2b' ? 'e2b' : 'local';
const CONCURRENCY = Math.max(1, Number(args.concurrency || 2));
const LINE_WINDOW = 15;
const OUT = args.output || path.join(__dirname, '..', 'results', `security-scan-${MODEL.replace(/[^\w.-]/g, '_')}.json`);

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);


const DATA = require('./vulngym-cases.json');
const TARGETS = require('./targets.json');
const ADJUDICATIONS = fs.existsSync(path.join(__dirname, 'adjudications.json'))
    ? require('./adjudications.json')
    : {};

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');

/**
 * The key a person's judgment of one off-list finding is stored under: the
 * issue's own identity (class, file, function), so a judgment holds for the
 * same finding in a later run.
 */
const findingKey = (caseId, f) => `${caseId}|${f.vulnerabilityClass}|${norm(f.filePath)}|${f.symbol || ''}`;

function matches(finding, advisory) {
    const file = norm(finding.filePath);
    return advisory.locations.some(
        (l) =>
            norm(l.file) === file &&
            l.line >= finding.startLine - LINE_WINDOW &&
            l.line <= finding.endLine + LINE_WINDOW,
    );
}

async function runCase(c, route, pricing) {
    const startedAt = Date.now();
    {
        const { result, shipped, spend } = await scanRepository({ c, route, pricing, budgetUsd: BUDGET_USD, sandbox: SANDBOX });
        const inScope = c.advisories.filter((a) => a.class);
        const found = inScope.filter((a) => shipped.some((f) => matches(f, a)));
        const offList = shipped.filter((f) => !c.advisories.some((a) => matches(f, a)));
        const judged = offList.map((f) => ({ finding: f, verdict: ADJUDICATIONS[findingKey(c.id, f)] }));
        const listed = shipped.length - offList.length;
        const judgedReal = judged.filter((j) => j.verdict === 'real').length;
        const judgedFalse = judged.filter((j) => j.verdict === 'false').length;

        return {
            id: c.id,
            language: c.language,
            checks: `Of ${inScope.length} published ${inScope.length === 1 ? 'vulnerability' : 'vulnerabilities'} in ${c.repo}${c.commit ? `@${c.commit.slice(0, 8)}` : ''}, how many does a scan capped at $${BUDGET_USD} report?`,
            hits: found.length,
            total: inScope.length,
            // A miss in a file no unit reached is the budget's or the map's; a
            // miss in an examined file is the lens's.
            detail: inScope.map((a) => {
                const files = new Set(a.locations.map((l) => l.file));
                const touching = result.units.filter((u) => files.has(u.file) || u.relatedFiles.some((f) => files.has(f)));
                const rank = touching.length ? result.units.indexOf(touching[0]) : -1;
                return {
                    what: `${a.id} (${a.class}) ${a.title}`.slice(0, 200),
                    ok: found.includes(a),
                    examined: result.examinedFiles.some((f) => files.has(f)),
                    // A unit reached the file, but did its lenses include the advisory's class?
                    classPlanned: touching.some((u) => u.classes.includes(a.class)),
                    planRank: rank < 0 ? null : rank,
                };
            }),
            precision: { listed, judgedReal, judgedFalse, unjudged: judged.length - judgedReal - judgedFalse },
            rawFindings: result.findings.length,
            findings: shipped.map((f) => ({
                key: findingKey(c.id, f),
                matched: !offList.includes(f),
                verdict: ADJUDICATIONS[findingKey(c.id, f)] ?? null,
                class: f.vulnerabilityClass,
                severity: f.severity,
                file: f.filePath,
                lines: [f.startLine, f.endLine],
                symbol: f.symbol,
                title: f.title,
                description: f.description,
                reproduction: f.reproduction ? { executed: f.reproduction.executed, reproduced: f.reproduction.reproduced } : undefined,
            })),
            coverage: {
                units: result.units.length,
                done: result.progress.filter((p) => p.state === 'done').length,
                skippedByBudget: result.progress.filter((p) => p.state === 'skipped_budget').length,
                stoppedByBudget: result.stoppedByBudget,
            },
            spend,
            ms: Date.now() - startedAt,
        };
    }
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

/** Precision over the findings a person (or the dataset) has judged. */
function precisionOf(cases) {
    const p = cases.reduce(
        (acc, c) => ({
            listed: acc.listed + c.precision.listed,
            real: acc.real + c.precision.judgedReal,
            falseCount: acc.falseCount + c.precision.judgedFalse,
            unjudged: acc.unjudged + c.precision.unjudged,
        }),
        { listed: 0, real: 0, falseCount: 0, unjudged: 0 },
    );
    const judged = p.listed + p.real + p.falseCount;
    return { ...p, judged, value: judged ? (p.listed + p.real) / judged : null };
}

/** Re-reads a saved result with the current adjudications, no model call. */
function rescore(file) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const c of saved.cases) {
        let judgedReal = 0;
        let judgedFalse = 0;
        let unjudged = 0;
        for (const f of c.findings) {
            f.key = findingKey(c.id, { vulnerabilityClass: f.class, filePath: f.file, symbol: f.symbol });
            f.verdict = f.matched ? null : (ADJUDICATIONS[f.key] ?? null);
            if (f.matched) continue;
            if (f.verdict === 'real') judgedReal++;
            else if (f.verdict === 'false') judgedFalse++;
            else unjudged++;
        }
        c.precision = { listed: c.findings.filter((f) => f.matched).length, judgedReal, judgedFalse, unjudged };
    }
    return saved;
}

async function main() {
    if (args.rescore) {
        const saved = rescore(args.rescore);
        return report(saved.cases, saved.infra?.errors ?? [], saved.cases.length, saved.tokens);
    }
    const route = orgRouteOrExit(MODEL);
    const pricing = pricingResolver();
    const all = args.set === 'wiring' ? [require('./wiring-case')] : DATA.cases;
    const picked = args.cases ? all.filter((c) => String(args.cases).split(',').includes(c.id)) : all;

    const errors = [];
    const cases = (
        await pool(picked, CONCURRENCY, async (c) => {
            try {
                const r = await runCase(c, route, pricing);
                console.log(`${c.id}: ${r.hits}/${r.total} found · ${r.findings.length} issues from ${r.rawFindings} findings (${r.precision.listed} listed, ${r.precision.unjudged} to judge) · $${r.spend.usd.toFixed(2)}`);
                return r;
            } catch (error) {
                console.error(`${c.id}: not measured — ${error.message}`);
                errors.push({ id: c.id, error: String(error.message).slice(0, 300) });
                return null;
            }
        })
    ).filter(Boolean);

    return report(cases, errors, picked.length, tokensUsed());
}

function report(cases, errors, pickedCount, tokens) {
    const byLanguage = {};
    for (const lang of [...new Set(cases.map((c) => c.language))]) {
        const of = cases.filter((c) => c.language === lang);
        const hits = of.reduce((s, c) => s + c.hits, 0);
        const total = of.reduce((s, c) => s + c.total, 0);
        byLanguage[lang] = { recall: total ? hits / total : null, hits, total, precision: precisionOf(of) };
    }
    const hits = cases.reduce((s, c) => s + c.hits, 0);
    const total = cases.reduce((s, c) => s + c.total, 0);
    const precision = precisionOf(cases);

    const target = (TARGETS.models || {})[MODEL] || {};
    const result = {
        eval: 'security-scan',
        question: evalQuestion('evals/security-scan'),
        model: MODEL,
        runs: 1,
        metric: { name: 'recall', value: total ? hits / total : 0, floor: target.recall ?? null, baseline: null },
        precision,
        byLanguage,
        budgetUsd: BUDGET_USD,
        sandbox: SANDBOX,
        cases,
        tokens,
        infra: { errored: errors.length, total: pickedCount, errors },
    };

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(`\nrecall ${hits}/${total} · precision ${precision.value === null ? 'n/a' : (precision.value * 100).toFixed(0) + '%'} over ${precision.judged} judged (${precision.unjudged} unjudged) → ${OUT}`);
    for (const [lang, v] of Object.entries(byLanguage)) {
        console.log(`  ${lang}: recall ${v.hits}/${v.total}, precision ${v.precision.value === null ? 'n/a' : (v.precision.value * 100).toFixed(0) + '%'} (${v.precision.judged} judged, ${v.precision.unjudged} unjudged)`);
    }

    const problems = resultProblems(result);
    if (problems.length) console.error(`result problems: ${problems.join('; ')}`);
    if (errors.length > Math.floor(pickedCount * 0.05) || !cases.length) process.exit(2);
    if (args.gate) {
        if (!target.precision) {
            console.error(`not measured: no precision floor for ${MODEL} in targets.json`);
            process.exit(2);
        }
        const minJudged = target.minJudgedPerLanguage ?? 20;
        const short = Object.entries(byLanguage).filter(([, v]) => v.precision.judged < Math.min(minJudged, v.precision.judged + v.precision.unjudged));
        if (short.length) {
            console.error(`not measured: fewer than ${minJudged} judged findings in ${short.map(([l]) => l).join(', ')} (adjudications.json)`);
            process.exit(2);
        }
        const below = Object.entries(byLanguage).filter(([, v]) => v.precision.value === null || v.precision.value < target.precision);
        if (below.length) {
            console.error(`below the precision floor: ${below.map(([l, v]) => `${l} ${(v.precision.value * 100).toFixed(0)}%`).join(', ')}`);
            process.exit(1);
        }
    }
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(2);
});
