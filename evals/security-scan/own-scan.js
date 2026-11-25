#!/usr/bin/env node
// security-scan on what a production scan reported: does the scan's own
// independent check refute the findings people judged false and keep the
// real ones, at the severity they judged; and does the root-cause comparison
// fold the issues people judged one bug, without folding different bugs?
//
//   node evals/security-scan/own-scan.js --dataset=<labelled scan.json>
//     [--model=<tier-0 id>] [--stages=verify,consolidate] [--limit=N]
//     [--concurrency=N] [--output=<result.json>]
//
// The dataset is a production scan's stored issues with a person's (or a
// fixed-rubric judge's) verdict, expected severity and duplicate clusters. It
// describes real, possibly unfixed vulnerabilities of the scanned repository,
// so it never lives in this public repository: Kodus keeps its own in the
// private kodustech/kodus-eval-runs (gold/deep-scan-<repo>-<version>.json).
//
// verify: production's SecurityScanEngine.verifyReported (the check a scan
// runs on each finding before it ships) on production's sandbox over the
// repository at the scanned commit, with the model routed like an org's BYOK
// model. consolidate: production's consolidateOpenIssues over every stored
// issue, through the same model call the end of a scan makes.
const fs = require('fs');
const path = require('path');

const { countTokens, tokensUsed, registerTs } = require('../shared/eval-kit');
const { orgRouteOrExit, evalPermissionService, EVAL_ORG } = require('../shared/model-route');

registerTs();
countTokens();

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
if (!args.dataset) {
    console.error('--dataset=<labelled scan.json> is required (see the header).');
    process.exit(2);
}
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const STAGES = String(args.stages || 'verify,consolidate').split(',');
const CONCURRENCY = Math.max(1, Number(args.concurrency || 6));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const OUT = args.output || path.join(__dirname, '..', 'results', `security-scan-own-${MODEL.replace(/[^\w.-]/g, '_')}.json`);
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const LIBS = path.join(__dirname, '../../libs');
const lib = (p) => require(path.join(LIBS, p));

const SEVERITY = ['low', 'medium', 'high', 'critical'];

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i], i);
            }
        }),
    );
    return out;
}

/** A stored issue as the engine holds a finding. */
function findingOf(issue) {
    return {
        unitId: 'stored',
        vulnerabilityClass: issue.vulnerabilityClass,
        cwe: issue.cwe,
        title: issue.title,
        description: issue.description,
        severity: issue.severity,
        filePath: issue.filePath,
        startLine: issue.startLine ?? 1,
        endLine: issue.endLine ?? issue.startLine ?? 1,
        language: 'unknown',
        symbol: issue.symbol,
        attackPath: issue.attackPath ?? [],
    };
}

async function verifyStage(dataset, route, pricing) {
    const { SecurityScanEngine } = lib('security-scan/application/security-scan-engine.ts');
    const { resolveScanModel } = lib('security-scan/application/scan-model.ts');
    const { ScanBudgetMeter } = lib('security-scan/domain/budget-meter.ts');
    const { openSandbox } = require('./scan-repo');

    const { model, rates } = await resolveScanModel({
        organizationAndTeamData: EVAL_ORG,
        permissionValidationService: evalPermissionService(route.storedConfig),
        pricingResolver: pricing,
    });
    const meter = new ScanBudgetMeter(rates ? { maxUsd: Number(args.budget || 40) } : { maxTokens: 80_000_000 }, rates);
    const sandbox = await openSandbox({ repo: dataset.repo, commit: dataset.commit }, 'local');
    const engine = new SecurityScanEngine();
    const labelled = dataset.issues.filter((i) => i.label && i.label.verdict !== 'uncertain').slice(0, LIMIT);
    try {
        const rows = await pool(labelled, CONCURRENCY, async (issue, i) => {
            const started = Date.now();
            try {
                const verdict = await engine.verifyReported(
                    {
                        organizationId: EVAL_ORG.organizationId,
                        teamId: EVAL_ORG.teamId,
                        repositoryId: dataset.repo,
                        repositoryFullName: dataset.repo,
                        sandbox,
                        model,
                        meter,
                        maxUnits: 1,
                        reproduce: false,
                    },
                    findingOf(issue),
                );
                const row = {
                    fingerprint: issue.fingerprint,
                    title: issue.title,
                    label: issue.label.verdict,
                    expectedSeverity: issue.label.expectedSeverity,
                    reportedSeverity: issue.severity,
                    keep: verdict.keep,
                    judged: verdict.judged,
                    severity: verdict.severity ?? issue.severity,
                    assumption: verdict.assumption,
                    rationale: verdict.rationale,
                    ms: Date.now() - started,
                };
                if ((i + 1) % 10 === 0) console.log(`verify ${i + 1}/${labelled.length}`);
                return row;
            } catch (error) {
                return { fingerprint: issue.fingerprint, label: issue.label.verdict, error: String(error?.message ?? error).slice(0, 300) };
            }
        });
        return { rows, spend: meter.committedSpend() };
    } finally {
        await sandbox.cleanup().catch(() => undefined);
    }
}

function scoreVerify(rows) {
    const measured = rows.filter((r) => !r.error && r.judged);
    const real = measured.filter((r) => r.label === 'real');
    const fake = measured.filter((r) => r.label === 'false');
    const keptReal = real.filter((r) => r.keep).length;
    const refutedFalse = fake.filter((r) => !r.keep).length;
    const keptAll = measured.filter((r) => r.keep);
    const precisionBefore = real.length / Math.max(1, real.length + fake.length);
    const precisionAfter = keptReal / Math.max(1, keptAll.length);
    const sevDistance = (a, b) => Math.abs(SEVERITY.indexOf(a) - SEVERITY.indexOf(b));
    const exactBefore = real.filter((r) => r.reportedSeverity === r.expectedSeverity).length;
    const exactAfter = real.filter((r) => r.keep && r.severity === r.expectedSeverity).length;
    return {
        measured: measured.length,
        unmeasured: rows.length - measured.length,
        realKept: `${keptReal}/${real.length}`,
        falseRefuted: `${refutedFalse}/${fake.length}`,
        recallKept: keptReal / Math.max(1, real.length),
        falseRemoved: refutedFalse / Math.max(1, fake.length),
        precisionBefore,
        precisionAfter,
        severityExactBefore: exactBefore / Math.max(1, real.length),
        severityExactAfterOfKept: exactAfter / Math.max(1, keptReal),
        severityMeanDistanceBefore: real.reduce((s, r) => s + sevDistance(r.reportedSeverity, r.expectedSeverity), 0) / Math.max(1, real.length),
        severityMeanDistanceAfter: real.filter((r) => r.keep).reduce((s, r) => s + sevDistance(r.severity, r.expectedSeverity), 0) / Math.max(1, keptReal),
        criticalBefore: measured.filter((r) => r.reportedSeverity === 'critical').length,
        criticalAfter: keptAll.filter((r) => r.severity === 'critical').length,
        lostReal: real.filter((r) => !r.keep).map((r) => ({ fingerprint: r.fingerprint, title: r.title, rationale: r.rationale })),
    };
}

async function consolidateStage(dataset, route, pricing) {
    const { consolidateOpenIssues, rootCauseCallOn } = lib('security-scan/application/scan-consolidation.ts');
    const { resolveScanModel } = lib('security-scan/application/scan-model.ts');
    const { ScanBudgetMeter } = lib('security-scan/domain/budget-meter.ts');
    const { runWithUsageMeter } = lib('llm/usage-meter.ts');
    const { LLM } = lib('llm/llm.ts');

    const { model, rates } = await resolveScanModel({
        organizationAndTeamData: EVAL_ORG,
        permissionValidationService: evalPermissionService(route.storedConfig),
        pricingResolver: pricing,
    });
    const meter = new ScanBudgetMeter(rates ? { maxUsd: 20 } : { maxTokens: 40_000_000 }, rates);
    const open = dataset.issues.map((i) => ({ ...findingOf(i), fingerprint: i.fingerprint }));
    const subjects = new Set(open.map((i) => i.fingerprint));
    // Production's call, with each question and answer kept for the score:
    // why a labelled duplicate stayed apart.
    const call = rootCauseCallOn(LLM.run.bind(LLM), model.slot, EVAL_ORG.organizationId);
    const decisions = [];
    const recorded = async (request) => {
        const answer = await call(request).catch((error) => {
            decisions.push({ user: request.user, error: String(error?.message ?? error) });
            throw error;
        });
        decisions.push({ user: request.user, answer });
        return answer;
    };
    const result = await runWithUsageMeter(
        meter,
        () => consolidateOpenIssues(recorded, open, subjects),
        { organizationId: EVAL_ORG.organizationId },
    );
    return { ...result, decisions, spend: meter.committedSpend() };
}

/**
 * Why each labelled duplicate pair stayed apart: never shown to the model
 * (rootCauseCandidates did not link them), shown and judged another problem
 * (with the model's reason), or its comparison failed.
 */
function missedPairs(dataset, result, root) {
    const { rootCauseCandidates } = lib('security-scan/domain/root-cause.ts');
    const pool = dataset.issues.map((i) => ({ ...findingOf(i), fingerprint: i.fingerprint }));
    const byFp = new Map(pool.map((p) => [p.fingerprint, p]));
    const asked = (subject, other) =>
        result.decisions.filter((d) => {
            const [newPart, reported = ''] = d.user.split('Already reported:');
            return newPart.includes(subject.title) && reported.includes(other.title);
        });
    const out = [];
    for (const c of dataset.clusters.filter((c) => c.kind === 'same_bug')) {
        const members = c.fingerprints.map((fp) => byFp.get(fp)).filter(Boolean);
        if (new Set(members.map((m) => root(m.fingerprint))).size === 1) continue;
        const pairs = [];
        for (const a of members) {
            for (const b of members) {
                if (a === b || root(a.fingerprint) === root(b.fingerprint)) continue;
                const proposed = rootCauseCandidates(a, pool).includes(b);
                const seen = asked(a, b);
                pairs.push({
                    subject: a.title,
                    other: b.title,
                    outcome: !proposed ? 'not-proposed' : !seen.length ? 'not-asked' : seen.some((d) => d.error) ? 'failed' : 'judged-different',
                    answers: seen.map((d) => d.answer ?? { error: d.error }),
                });
            }
        }
        out.push({ cluster: c.id, why: c.why, pairs });
    }
    return out;
}

function scoreConsolidate(dataset, result) {
    const clusterOf = new Map();
    for (const c of dataset.clusters) {
        for (const fp of c.fingerprints) if (!clusterOf.has(fp)) clusterOf.set(fp, c);
        for (const fp of c.related ?? []) if (!clusterOf.has(fp)) clusterOf.set(fp, c);
    }
    const mustFold = dataset.clusters.filter((c) => c.kind === 'same_bug');
    const redundant = mustFold.reduce((s, c) => s + c.fingerprints.length - 1, 0);
    // The cluster an issue ends in: the one that stays.
    const stays = new Map();
    for (const a of result.absorbed) stays.set(a.issue.fingerprint, a.into.fingerprint);
    const root = (fp) => {
        let at = fp;
        for (let i = 0; i < 10 && stays.has(at); i++) at = stays.get(at);
        return at;
    };
    let folded = 0;
    for (const c of mustFold) {
        const roots = new Set(c.fingerprints.map(root));
        folded += c.fingerprints.length - roots.size;
    }
    const sameCluster = (a, b) => {
        const ca = clusterOf.get(a);
        return !!ca && ca === clusterOf.get(b);
    };
    const folds = result.absorbed.map((a) => ({
        issue: a.issue.title,
        into: a.into.title,
        same: sameCluster(a.issue.fingerprint, a.into.fingerprint),
        reason: a.reason,
    }));
    const issues = dataset.issues.length;
    return {
        issuesBefore: issues,
        issuesAfter: issues - result.absorbed.length,
        redundantInClusters: redundant,
        redundantFolded: folded,
        foldsInsideClusters: folds.filter((f) => f.same).length,
        // Not in a labelled cluster: a person reads each one (a missed
        // cluster in the first-pass labels, or a wrong fold).
        foldsToReview: folds.filter((f) => !f.same),
        missed: missedPairs(dataset, result, root),
        failures: result.failures,
    };
}

async function main() {
    const dataset = JSON.parse(fs.readFileSync(args.dataset, 'utf8'));
    const { pricingResolver } = require('./scan-repo');
    const route = orgRouteOrExit(MODEL);
    const pricing = pricingResolver();
    const started = Date.now();
    const result = { eval: 'security-scan-own', dataset: dataset.name, repo: dataset.repo, commit: dataset.commit, model: MODEL, stages: STAGES };

    if (STAGES.includes('verify')) {
        const { rows, spend } = await verifyStage(dataset, route, pricing);
        result.verify = { ...scoreVerify(rows), spend, rows };
        const v = result.verify;
        console.log(`\nverify: real kept ${v.realKept} · false refuted ${v.falseRefuted} · precision ${(100 * v.precisionBefore).toFixed(0)}% → ${(100 * v.precisionAfter).toFixed(0)}% · severity exact ${(100 * v.severityExactBefore).toFixed(0)}% → ${(100 * v.severityExactAfterOfKept).toFixed(0)}% · critical ${v.criticalBefore} → ${v.criticalAfter} · $${spend.usd.toFixed(2)}`);
    }
    if (STAGES.includes('consolidate')) {
        const out = await consolidateStage(dataset, route, pricing);
        result.consolidate = { ...scoreConsolidate(dataset, out), spend: out.spend };
        const c = result.consolidate;
        console.log(`consolidate: issues ${c.issuesBefore} → ${c.issuesAfter} · redundant folded ${c.redundantFolded}/${c.redundantInClusters} · folds outside labelled clusters ${c.foldsToReview.length} · failures ${c.failures} · $${out.spend.usd.toFixed(2)}`);
    }
    result.tokens = tokensUsed();
    result.ms = Date.now() - started;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(`→ ${OUT}`);
    const unmeasured = result.verify ? result.verify.unmeasured / Math.max(1, result.verify.measured + result.verify.unmeasured) : 0;
    process.exit(unmeasured > 0.05 ? 2 : 0);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
});
